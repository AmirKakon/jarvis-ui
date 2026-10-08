#!/usr/bin/env python3
"""Audit the devices of one Home Assistant integration and flag ones that look unused.

Read-only: only GET requests plus a template render. Usage:
    python3 ha-integration-audit.py [integration] [--days N] [--json]
integration defaults to "tuya". Reads HA_URL / HA_TOKEN from the environment,
falling back to ~/jarvis/.env.

Per device it reports: current state, how often its controllable entities
(switch/light/climate/...) changed in the last N days (= someone used it), how
often its sensors reported, and which automations/scripts/scenes reference it.
Dashboards are not checked (that needs the websocket API).
"""
import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

CONTROL_DOMAINS = {
    "switch", "light", "fan", "climate", "cover", "select", "number", "button",
    "scene", "lock", "vacuum", "humidifier", "water_heater", "siren",
    "media_player", "remote", "valve", "alarm_control_panel", "text",
}
DEAD = {"unavailable", "unknown"}


def load_config():
    url, token = os.environ.get("HA_URL"), os.environ.get("HA_TOKEN")
    env_file = os.path.expanduser("~/jarvis/.env")
    if (not url or not token) and os.path.exists(env_file):
        with open(env_file) as f:
            for line in f:
                m = re.match(r"^\s*(HA_URL|HA_TOKEN)\s*=\s*(.*?)\s*$", line)
                if m:
                    val = m.group(2).strip("'\"")
                    if m.group(1) == "HA_URL" and not url:
                        url = val
                    elif m.group(1) == "HA_TOKEN" and not token:
                        token = val
    if not url or not token:
        sys.exit("HA_URL / HA_TOKEN not set (env or ~/jarvis/.env)")
    return url.rstrip("/"), token


class HA:
    def __init__(self, url, token):
        self.url, self.token = url, token

    def request(self, path, body=None):
        req = urllib.request.Request(
            self.url + path,
            data=json.dumps(body).encode() if body is not None else None,
            headers={"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"},
            method="POST" if body is not None else "GET",
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                raw = r.read().decode()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            sys.exit(f"HA {path.split('?')[0]} -> HTTP {e.code}")
        except urllib.error.URLError as e:
            sys.exit(f"Cannot reach HA at {self.url}: {e.reason}")
        try:
            return json.loads(raw)
        except ValueError:
            return raw


TEMPLATE = """
{%- set ns = namespace(rows=[]) -%}
{%- for e in integration_entities('INTEGRATION') -%}
  {%- set d = device_id(e) -%}
  {%- set ns.rows = ns.rows + [{
    'entity': e,
    'device': d,
    'name': (device_attr(d, 'name_by_user') or device_attr(d, 'name')) if d else none,
    'model': device_attr(d, 'model') if d else none,
    'area': area_name(d) if d else none,
    'disabled': device_attr(d, 'disabled_by') if d else none,
  }] -%}
{%- endfor -%}
{{ ns.rows | tojson }}
"""


def registry_rows(ha, integration):
    out = ha.request("/api/template", {"template": TEMPLATE.replace("INTEGRATION", integration)})
    return json.loads(out) if isinstance(out, str) else (out or [])


def change_counts(ha, entity_ids, days):
    """State changes per entity over the window, ignoring unavailable/unknown flaps (restarts)."""
    start = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    counts = {}
    for i in range(0, len(entity_ids), 40):
        chunk = entity_ids[i:i + 40]
        q = urllib.parse.urlencode({
            "filter_entity_id": ",".join(chunk),
            "minimal_response": "",
            "no_attributes": "",
            "significant_changes_only": "0",
        })
        hist = ha.request(f"/api/history/period/{urllib.parse.quote(start)}?{q}") or []
        for series in hist:
            if not series:
                continue
            eid = series[0].get("entity_id")
            n, prev = 0, None
            for point in series:
                s = point.get("state")
                if s in DEAD:
                    continue
                if prev is not None and s != prev:
                    n += 1
                prev = s
            counts[eid] = n
    return counts


def references(ha, states):
    """Map name -> serialized config for every automation/script/scene HA can return config for."""
    refs = {}
    for s in states:
        eid, attrs = s["entity_id"], s.get("attributes", {})
        domain, obj = eid.split(".", 1)
        name = attrs.get("friendly_name", eid)
        if domain == "automation" and attrs.get("id"):
            cfg = ha.request(f"/api/config/automation/config/{urllib.parse.quote(str(attrs['id']))}")
            label = f"automation: {name}" + (" (off)" if s["state"] == "off" else "")
        elif domain == "script":
            cfg = ha.request(f"/api/config/script/config/{urllib.parse.quote(obj)}")
            label = f"script: {name}"
        elif domain == "scene" and attrs.get("id"):
            cfg = ha.request(f"/api/config/scene/config/{urllib.parse.quote(str(attrs['id']))}")
            label = f"scene: {name}"
        else:
            continue
        if cfg:
            refs[label] = json.dumps(cfg)
    return refs


def main():
    p = argparse.ArgumentParser(description="Flag unused devices of a Home Assistant integration.")
    p.add_argument("integration", nargs="?", default="tuya")
    p.add_argument("--days", type=int, default=10, help="activity window (HA recorder keeps 10 days by default)")
    p.add_argument("--json", action="store_true", dest="as_json")
    opts = p.parse_args()
    integration, days, as_json = opts.integration, opts.days, opts.as_json
    if not re.fullmatch(r"[a-z0-9_]+", integration):
        sys.exit("integration must be a domain like tuya / localtuya / tuya_local")

    ha = HA(*load_config())
    rows = registry_rows(ha, integration)
    if not rows:
        sys.exit(f"No entities found for integration '{integration}'. Try localtuya or tuya_local.")

    states = ha.request("/api/states") or []
    by_id = {s["entity_id"]: s for s in states}
    counts = change_counts(ha, [r["entity"] for r in rows if r["entity"] in by_id], days)
    refs = references(ha, states)

    devices = {}
    for r in rows:
        key = r["device"] or r["entity"]
        d = devices.setdefault(key, {
            "device": r["name"] or r["entity"], "area": r["area"], "model": r["model"],
            "disabled": r["disabled"], "entities": [], "used": 0, "reports": 0,
            "has_control": False, "refs": set(),
        })
        st = by_id.get(r["entity"])
        domain = r["entity"].split(".")[0]
        n = counts.get(r["entity"], 0)
        if domain in CONTROL_DOMAINS:
            d["has_control"] = True
            d["used"] += n
        else:
            d["reports"] += n
        d["entities"].append({"entity": r["entity"], "state": st["state"] if st else "not loaded"})
        ent_re = re.compile(rf"(?<![\w.]){re.escape(r['entity'])}(?!\w)")
        for label, blob in refs.items():
            if ent_re.search(blob) or (r["device"] and r["device"] in blob):
                d["refs"].add(label)

    for d in devices.values():
        loaded = [e for e in d["entities"] if e["state"] != "not loaded"]
        if d["disabled"] or not loaded:
            d["verdict"] = "disabled"
        elif all(e["state"] in DEAD for e in loaded):
            d["verdict"] = "offline"
        elif d["used"] == 0 and not d["refs"]:
            d["verdict"] = "unused" if d["has_control"] else ("silent sensor" if d["reports"] == 0 else "sensor only")
        elif d["used"] == 0:
            d["verdict"] = "automation only"
        else:
            d["verdict"] = "in use"
        d["refs"] = sorted(d["refs"])

    order = ["offline", "disabled", "unused", "silent sensor", "sensor only", "automation only", "in use"]
    result = sorted(devices.values(), key=lambda d: (order.index(d["verdict"]), (d["device"] or "").lower()))

    if as_json:
        print(json.dumps(result, indent=2))
        return

    print(f"{integration}: {len(result)} devices, {len(rows)} entities. Activity window: last {days} days.")
    print("used = state changes of controllable entities; reports = sensor updates. Dashboards not checked.\n")
    for verdict in order:
        group = [d for d in result if d["verdict"] == verdict]
        if not group:
            continue
        print(f"== {verdict.upper()} ({len(group)})")
        for d in group:
            meta = " | ".join(x for x in [d["area"], d["model"]] if x)
            print(f"  - {d['device']}" + (f"  [{meta}]" if meta else ""))
            print(f"      used {d['used']}x, reports {d['reports']}x; "
                  + ", ".join(f"{e['entity']}={e['state']}" for e in d["entities"][:4])
                  + (f" (+{len(d['entities']) - 4} more)" if len(d["entities"]) > 4 else ""))
            if d["refs"]:
                print("      referenced by: " + "; ".join(d["refs"][:4])
                      + (f" (+{len(d['refs']) - 4} more)" if len(d["refs"]) > 4 else ""))
        print()


if __name__ == "__main__":
    main()
