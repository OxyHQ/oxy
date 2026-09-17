#!/usr/bin/env python3
"""Read existing live API logs; emit only classified events for one public actor."""
import datetime
import json
import os
import re
import subprocess
import sys
from pathlib import Path

CLUSTER = "oxy-cluster"
SERVICE = "oxy-api"
CONTAINER = "oxy-api"
REGISTRY = "237343248947.dkr.ecr.us-west-2.amazonaws.com/oxy/oxy-api"
TASK_PREFIX = "arn:aws:ecs:us-west-2:237343248947:task/oxy-cluster/"
DEFINITION_PATTERN = r"arn:aws:ecs:us-west-2:237343248947:task-definition/[A-Za-z0-9_-]+:[0-9]+"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def utc_milliseconds(value):
    require(bool(re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", value)), "Use an exact UTC timestamp ending in Z")
    return int(datetime.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000)


def configuration(env, now_ms):
    require(env.get("GITHUB_REF") == "refs/heads/main" and env.get("GITHUB_REF_PROTECTED") == "true", "Protected main required")
    require(bool(env.get("GITHUB_ACTOR")) and env.get("GITHUB_TRIGGERING_ACTOR") == env.get("GITHUB_ACTOR"), "Same dispatching operator required")
    sha = env.get("EXPECTED_SOURCE_SHA", "")
    digest = env.get("EXPECTED_IMAGE_DIGEST", "")
    require(bool(re.fullmatch(r"[0-9a-f]{40}", sha)), "Exact deployed source SHA required")
    require(bool(re.fullmatch(r"sha256:[0-9a-f]{64}", digest)), "Exact deployed image digest required")
    actor = env.get("ACTOR_URI", "")
    match = re.fullmatch(r"https://(bird\.makeup|kilogram\.makeup)/users/([a-z0-9_][a-z0-9_.-]{0,127})", actor)
    require(match is not None, "Exact reviewed Bird or Kilogram public actor URI required")
    acct = env.get("TRANSPORT_ACCT", "")
    require(acct == f"{match[2]}@{match[1]}", "Actor URI and transport account must agree")
    start = utc_milliseconds(env.get("WINDOW_START", ""))
    end = utc_milliseconds(env.get("WINDOW_END", ""))
    require(0 < end - start <= 15 * 60_000 and end <= now_ms and now_ms - start <= 24 * 60 * 60_000,
            "Window must be past, at most 15 minutes long, and within the last 24 hours")
    return {"sourceSha": sha, "imageDigest": digest, "actorUri": actor, "transportAcct": acct,
            "startMs": start, "endMs": end}


def error_class(text):
    # Never emit arbitrary exception text; it can contain remote bodies or secrets.
    for pattern, category in [(r"timeout|timed out|abort", "timeout"), (r"ENOTFOUND|EAI_AGAIN", "dns"),
                              (r"ECONNRESET|ECONNREFUSED|socket", "connection"),
                              (r"certificate|TLS|SSL", "tls"), (r"JSON|Unexpected token", "json"),
                              (r"size|too large|limit", "size_limit")]:
        if re.search(pattern, text, re.I):
            return category
    return "unclassified"


def classify(message, config, record=None):
    actor = config["actorUri"]
    acct = config["transportAcct"]
    if message == "Federation identity resolution failed" and isinstance(record, dict):
        phases = {"actor_fetch", "actor_document", "identity_policy", "webfinger_fetch", "webfinger_document"}
        reasons = {"transport_unavailable", "http_status", "unreadable_document", "missing_actor_fields", "actor_id_mismatch", "identity_policy_rejected", "missing_self_link", "unexpected_failure", "invalid_selector"}
        if (record.get("operation") != "resolve_external_identity" or not isinstance(record.get("phase"), str)
                or not isinstance(record.get("reason"), str) or record.get("phase") not in phases
                or record.get("reason") not in reasons or record.get("actorUri") not in (None, actor)
                or record.get("acct") not in (None, acct)
                or not (record.get("actorUri") == actor or record.get("acct") == acct)):
            return None
        event = {"event": "resolution_failed", "phase": record["phase"], "reason": record["reason"]}
        status = record.get("httpStatus")
        if status is not None:
            if type(status) is not int or not 100 <= status <= 599:
                return None
            event["httpStatus"] = status
        return event
    for prefix, kind in [(f"Failed to fetch actor profile {actor}: ", "actor_profile_exception"),
                         (f"Federation fetch failed for {actor}: ", "federation_fetch_exception"),
                         (f"WebFinger resolution failed for {acct}: ", "webfinger_exception")]:
        if message.startswith(prefix):
            return {"event": kind, "errorClass": error_class(message[len(prefix):])}
    signed = re.fullmatch(r"\[Federation\] signedFetch got ([1-5][0-9]{2}) for " + re.escape(actor)
                          + r"(, retrying unsigned| — remote rejected our HTTP signature)", message)
    if signed:
        return {"event": "signed_fetch_unsigned_retry" if signed[2].startswith(",") else "signature_rejected", "httpStatus": int(signed[1])}
    if message.startswith("Federation URL rejected by SSRF guard (") and message.endswith(f"): {actor}"):
        return {"event": "ssrf_rejected"}
    remote = re.match(r"\[FedSync\] fetchRemoteActor HTTP ([1-5][0-9]{2}) [^\n]*? for " + re.escape(actor) + r" body=", message)
    if remote:
        return {"event": "actor_http_failure", "httpStatus": int(remote[1])}
    if message.startswith(f"[FedSync] fetchRemoteActor missing fields for {actor}: "):
        return {"event": "actor_missing_fields"}
    return None


def live_service(aws):
    reply = aws(["ecs", "describe-services", "--cluster", CLUSTER, "--services", SERVICE, "--output", "json"])
    require(not reply.get("failures") and len(reply.get("services", [])) == 1, "Expected exactly one live service")
    service = reply["services"][0]
    require(service.get("status") == "ACTIVE" and 0 < service.get("desiredCount", 0) <= 10
            and service.get("runningCount") == service["desiredCount"] and service.get("pendingCount") == 0
            and len(service.get("deployments", [])) == 1 and service["deployments"][0].get("rolloutState") == "COMPLETED", "Live service must have one healthy settled deployment of at most ten tasks")
    require(bool(re.fullmatch(DEFINITION_PATTERN, service.get("taskDefinition", ""))), "Unexpected live task definition")
    return service


def list_live_tasks(aws):
    reply = aws(["ecs", "list-tasks", "--cluster", CLUSTER, "--service-name", SERVICE, "--desired-status", "RUNNING", "--output", "json"])
    tasks = reply.get("taskArns", [])
    require(not reply.get("nextToken") and 0 < len(tasks) <= 10 and len(set(tasks)) == len(tasks), "Incomplete or excessive live task list")
    require(all(re.fullmatch(re.escape(TASK_PREFIX) + r"[0-9a-f]{32}", task) for task in tasks), "Unexpected task ARN")
    return sorted(tasks)


def readback(env, aws, now_ms):
    config = configuration(env, now_ms)  # Reject invalid inputs before ANY AWS call.
    service = live_service(aws)
    image = aws(["ecr", "batch-get-image", "--repository-name", "oxy/oxy-api", "--image-ids", "imageTag=" + config["sourceSha"], "--output", "json"])
    require(not image.get("failures") and len(image.get("images", [])) == 1
            and image["images"][0].get("imageId", {}).get("imageDigest") == config["imageDigest"], "Source SHA does not name the reviewed digest")
    definition = aws(["ecs", "describe-task-definition", "--task-definition", service["taskDefinition"], "--query", "taskDefinition", "--output", "json"])
    require(definition.get("taskDefinitionArn") == service["taskDefinition"], "Task definition mismatch")
    containers = [item for item in definition.get("containerDefinitions", []) if item.get("name") == CONTAINER]
    require(len(containers) == 1 and containers[0].get("image") in [REGISTRY + "@" + config["imageDigest"], REGISTRY + ":" + config["sourceSha"]], "Live task definition must pin the reviewed source or digest")
    logging = containers[0].get("logConfiguration", {})
    options = logging.get("options", {})
    require(logging.get("logDriver") == "awslogs" and options.get("awslogs-group") == "/oxy/ecs"
            and options.get("awslogs-stream-prefix") == "oxy-api", "Unexpected live API log destination")
    tasks = list_live_tasks(aws)
    require(len(tasks) == service["desiredCount"], "Live task count changed")
    reply = aws(["ecs", "describe-tasks", "--cluster", CLUSTER, "--tasks", *tasks, "--output", "json"])
    require(not reply.get("failures") and len(reply.get("tasks", [])) == len(tasks)
            and sorted(task.get("taskArn", "") for task in reply["tasks"]) == tasks, "Incomplete live task descriptions")
    for task in reply["tasks"]:
        matched = [item for item in task.get("containers", []) if item.get("name") == CONTAINER]
        require(task.get("lastStatus") == "RUNNING" and task.get("taskDefinitionArn") == service["taskDefinition"]
                and len(matched) == 1 and matched[0].get("imageDigest") == config["imageDigest"], "Live task image differs from the reviewed deployment")
    result = {"operation": "read_existing_identity_api_logs", **config, "taskDefinitionArn": service["taskDefinition"],
              "coverage": "current_live_task_streams_only", "silentNullBranchesPossible": True, "events": [], "streams": []}
    for task in reply["tasks"]:
        stream = "oxy-api/oxy-api/" + task["taskArn"].rsplit("/", 1)[1]
        token = None
        pages = 0
        for _ in range(100):
            args = ["logs", "get-log-events", "--log-group-name", "/oxy/ecs", "--log-stream-name", stream,
                    "--start-time", str(config["startMs"]), "--end-time", str(config["endMs"]), "--start-from-head", "--output", "json"]
            if token:
                args += ["--next-token", token]
            page = aws(args)
            pages += 1
            for event in page.get("events", []):
                timestamp = event.get("timestamp")
                if not isinstance(timestamp, int) or not config["startMs"] <= timestamp < config["endMs"]:
                    continue
                try:
                    record = json.loads(event.get("message", ""))
                except (json.JSONDecodeError, TypeError):
                    continue
                if not isinstance(record, dict) or not isinstance(record.get("msg"), str):
                    continue
                selected = classify(record["msg"], config, record)
                if selected:
                    result["events"].append({"timestampMs": timestamp, "taskArn": task["taskArn"], **selected})
            next_token = page.get("nextForwardToken")
            if not next_token or next_token == token:
                break
            token = next_token
        else:
            raise ValueError("CloudWatch paging bound exceeded; incomplete readback")
        result["streams"].append({"taskArn": task["taskArn"], "startedAt": task.get("startedAt"), "pagesRead": pages})
    current = live_service(aws)
    require(current["taskDefinition"] == service["taskDefinition"] and list_live_tasks(aws) == tasks, "Deployment changed during readback")
    result["events"].sort(key=lambda item: item["timestampMs"])
    result["matchingEvents"] = len(result["events"])
    result["interpretation"] = "Only classified existing events are shown; zero matches cannot rule out silent failures."
    return result


def call_aws(args):
    completed = subprocess.run(["aws", *args, "--region", "us-west-2", "--cli-connect-timeout", "5", "--cli-read-timeout", "15"], capture_output=True, text=True,
                               env={**os.environ, "AWS_PAGER": "", "AWS_MAX_ATTEMPTS": "2"}, timeout=50)
    require(completed.returncode == 0, "AWS read failed: " + " ".join(args[:2]))
    return json.loads(completed.stdout)


if __name__ == "__main__":
    try:
        report = readback(os.environ, call_aws, int(datetime.datetime.now(datetime.timezone.utc).timestamp() * 1000))
        directory = Path("identity-api-log-readback")
        directory.mkdir(exist_ok=True)
        (directory / "report.json").write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps({"operation": report["operation"], "matchingEvents": report["matchingEvents"], "interpretation": report["interpretation"]}))
    except Exception as error:
        # AWS output and arbitrary exception details are never printed or retained.
        print("Readback failed: " + (str(error) if isinstance(error, ValueError) and not isinstance(error, json.JSONDecodeError) else type(error).__name__), file=sys.stderr)
        sys.exit(1)
