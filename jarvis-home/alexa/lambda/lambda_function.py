"""
AWS Lambda adapter: Alexa custom skill -> JARVIS.

Alexa invokes this Lambda by ARN (no HTTPS endpoint / port / cert needed on your
side — this sidesteps the port-443 requirement entirely). The Lambda forwards the
spoken utterance to the JARVIS brain's /ask endpoint and speaks back the reply.

It's the same idea as the popular "ChatGPT on Alexa" Lambda, but pointed at your
own JARVIS instead of OpenAI. The bot's /ask is the same brain the Telegram bot
uses (askCore), so you get memory, tools, HA control, etc.

Runtime: Python 3.12 (stdlib only — urllib, no pip packages, paste-able inline).
Handler: lambda_function.lambda_handler

Environment variables (Lambda console -> Configuration -> Environment variables):
  JARVIS_ASK_URL   required  e.g. https://kakischer.duckdns.org:20007/ask
                             (nginx must proxy /ask -> the bot on 127.0.0.1:20010)
  JARVIS_TOKEN     required  bearer token == ASK_HTTP_TOKEN in ~/jarvis/.env
  ALEXA_SKILL_ID   optional  amzn1.ask.skill.<...> — reject requests from other skills
  ASK_TIMEOUT      optional  seconds to wait for /ask (default 7; keep < Alexa's ~8s)

NOTE ON LATENCY: Alexa gives a skill ~8s to answer, and /ask answers inline, so
fast asks (weather, HA, a quick lookup) are fine. Long cross-provider MCP tasks
can exceed 8s; those are better handled via the bot's async HA-announce path
(the direct /alexa endpoint) — a future enhancement for this Lambda if needed.
"""

import os
import re
import json
import hashlib
import urllib.request
import urllib.error

ASK_URL = os.environ["JARVIS_ASK_URL"]
ASK_TOKEN = os.environ["JARVIS_TOKEN"]
SKILL_ID = os.environ.get("ALEXA_SKILL_ID", "").strip()
TIMEOUT = float(os.environ.get("ASK_TIMEOUT", "7"))

MAX_SPEECH = 7000


def _clean_for_speech(text):
    """Strip markdown/HTML so Alexa reads a clean sentence."""
    if not text:
        return ""
    t = str(text)
    t = re.sub(r"```.*?```", " ", t, flags=re.S)      # fenced code
    t = re.sub(r"`([^`]+)`", r"\1", t)                # inline code
    t = re.sub(r"<[^>]+>", " ", t)                    # html tags
    t = re.sub(r"!\[[^\]]*\]\([^)]*\)", " ", t)       # images
    t = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", t)    # links -> text
    t = re.sub(r"^\s*[-*\u2022]\s+", "", t, flags=re.M)  # bullets
    t = re.sub(r"[*_#>~]+", " ", t)                   # emphasis/headers
    t = re.sub(r"\s+", " ", t).strip()
    return t[:MAX_SPEECH]


def _response(text, end_session=False, reprompt="Anything else, Sir?"):
    body = {
        "version": "1.0",
        "response": {
            "outputSpeech": {"type": "PlainText", "text": _clean_for_speech(text) or "Yes, Sir?"},
            "shouldEndSession": end_session,
        },
    }
    if not end_session:
        body["response"]["reprompt"] = {"outputSpeech": {"type": "PlainText", "text": reprompt}}
    return body


def _application_id(event):
    return (
        event.get("context", {}).get("System", {}).get("application", {}).get("applicationId")
        or event.get("session", {}).get("application", {}).get("applicationId")
        or ""
    )


def _session_key(event):
    uid = (
        event.get("context", {}).get("System", {}).get("user", {}).get("userId")
        or event.get("session", {}).get("user", {}).get("userId")
        or "unknown"
    )
    # Hash so we don't carry the long raw Alexa userId; stable per account+skill.
    return "alexa:" + hashlib.sha256(uid.encode("utf-8")).hexdigest()[:16]


def _ask_jarvis(text, session_key):
    payload = json.dumps({"text": text, "sessionKey": session_key, "source": "alexa"}).encode("utf-8")
    req = urllib.request.Request(ASK_URL, data=payload, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Authorization", "Bearer " + ASK_TOKEN)
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    return (data.get("reply") or "").strip()


def lambda_handler(event, context):
    # Only serve OUR skill (the AWS trigger already restricts this, belt & braces).
    if SKILL_ID:
        app_id = _application_id(event)
        if app_id and app_id != SKILL_ID:
            return _response("This request isn't for me, Sir.", end_session=True)

    request = event.get("request", {}) or {}
    rtype = request.get("type")

    if rtype == "LaunchRequest":
        return _response("At your service, Sir. How may I help?")

    if rtype == "SessionEndedRequest":
        return {"version": "1.0", "response": {}}

    if rtype == "IntentRequest":
        intent = request.get("intent", {}) or {}
        name = intent.get("name", "")

        if name in ("AMAZON.StopIntent", "AMAZON.CancelIntent"):
            return _response("Very good, Sir.", end_session=True)
        if name == "AMAZON.HelpIntent":
            return _response("Ask me anything, Sir - the weather, your meal plan, "
                             "the pantry, the next bus, or to control the house.")

        if name in ("AskJarvisIntent", "GptQueryIntent"):
            slots = intent.get("slots", {}) or {}
            query = ((slots.get("query") or {}).get("value") or "").strip()
            if not query:
                return _response("I didn't catch that, Sir. What would you like?")
            try:
                reply = _ask_jarvis(query, _session_key(event))
            except urllib.error.HTTPError as e:
                if e.code == 429:
                    return _response("I'm rate limited at the moment, Sir. Try again shortly.")
                return _response("The home server returned an error, Sir.")
            except (urllib.error.URLError, TimeoutError):
                return _response("That took too long, or I couldn't reach the home server, Sir.")
            except Exception:
                return _response("Something went wrong, Sir.")
            return _response(reply or "Done, Sir.")

        # FallbackIntent / NavigateHome / anything else.
        return _response("I didn't quite catch that, Sir. Could you rephrase?")

    return _response("At your service, Sir.")
