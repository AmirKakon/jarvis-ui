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

NOTE ON LATENCY: Alexa gives a skill ~8s to answer. The Lambda asks /ask with
announceIfSlow, so fast asks (weather, HA, a quick lookup) are spoken inline,
while slow ones (e.g. inventory/recipe MCP lookups) get "Right away, Sir" now and
the Echo speaks the finished answer via Home Assistant a few seconds later.
"""

import os
import re
import json
import time
import socket
import hashlib
import urllib.request
import urllib.error
from urllib.parse import urlparse

ASK_URL = os.environ["JARVIS_ASK_URL"]
ASK_TOKEN = os.environ["JARVIS_TOKEN"]
SKILL_ID = os.environ.get("ALEXA_SKILL_ID", "").strip()
TIMEOUT = float(os.environ.get("ASK_TIMEOUT", "7"))
# The bot must reply before TIMEOUT expires here; the AWS <-> home round trip
# (TLS handshake included) costs ~1.5s, so leave a 2.5s margin.
BUDGET_MS = max(1000, int(TIMEOUT * 1000) - 2500)

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


def _log(**fields):
    # CloudWatch captures stdout. Never log the token or the Alexa userId.
    print(json.dumps(fields))


def _resolved_addresses(host, port):
    try:
        infos = socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
        return sorted({info[4][0] for info in infos})
    except Exception as e:
        return ["dns-error: %s" % e]


def _ask_jarvis(text, session_key):
    target = urlparse(ASK_URL)
    port = target.port or (443 if target.scheme == "https" else 80)
    _log(event="ask_start", scheme=target.scheme, host=target.hostname, port=port,
         path=target.path, resolved=_resolved_addresses(target.hostname, port))

    payload = json.dumps({
        "text": text,
        "sessionKey": session_key,
        "source": "alexa",
        "announceIfSlow": True,
        "budgetMs": BUDGET_MS,
    }).encode("utf-8")
    req = urllib.request.Request(ASK_URL, data=payload, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Authorization", "Bearer " + ASK_TOKEN)

    started = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            _log(event="ask_ok", status=resp.status, kind=data.get("kind"),
                 ms=int((time.monotonic() - started) * 1000))
    except Exception as e:
        _log(event="ask_error", error=type(e).__name__, detail=str(e)[:300],
             ms=int((time.monotonic() - started) * 1000))
        raise
    # "deferred": the reply is an acknowledgement; the Echo will speak the real
    # answer via Home Assistant once JARVIS finishes.
    return (data.get("reply") or "").strip(), data.get("kind") == "deferred"


def lambda_handler(event, context):
    # Only serve OUR skill (the AWS trigger already restricts this, belt & braces).
    if SKILL_ID:
        app_id = _application_id(event)
        if app_id and app_id != SKILL_ID:
            return _response("This request isn't for me, Sir.", end_session=True)

    request = event.get("request", {}) or {}
    rtype = request.get("type")
    intent_name = (request.get("intent") or {}).get("name")
    _log(event="request", type=rtype, intent=intent_name)

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
            _log(event="query", heard=query)
            if not query:
                return _response("I didn't catch that, Sir. What would you like?")
            try:
                reply, deferred = _ask_jarvis(query, _session_key(event))
            except urllib.error.HTTPError as e:
                if e.code == 429:
                    return _response("I'm rate limited at the moment, Sir. Try again shortly.")
                return _response("The home server returned an error, Sir.")
            except (urllib.error.URLError, TimeoutError):
                return _response("That took too long, or I couldn't reach the home server, Sir.")
            except Exception:
                return _response("Something went wrong, Sir.")
            # End the session on a deferred answer so the Echo isn't listening
            # when the Home Assistant announcement plays.
            return _response(reply or "Done, Sir.", end_session=deferred)

        # FallbackIntent / NavigateHome / anything else.
        return _response("I didn't quite catch that, Sir. Could you rephrase?")

    return _response("At your service, Sir.")
