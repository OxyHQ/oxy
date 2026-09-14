#!/usr/bin/env python3
"""Fixed AWS reads only; Redis URLs are consumed in memory and never emitted."""
import datetime as dt
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import urlsplit

GROUPS = {"oxy-valkey", "oxy-valkey-2", "oxy-valkey-queue"}
PARAMETERS = {"maxmemory-policy", "maxmemory", "reserved-memory-percent"}
SSM_NAMES = {"/oxy/_shared/REDIS_URL", "/oxy/mention/REDIS_URL", "/oxy/oxy-api/REDIS_URL"}
METRICS = {"BytesUsedForCache": "Maximum", "DatabaseMemoryUsagePercentage": "Maximum", "DatabaseMemoryUsageCountedForEvictPercentage": "Maximum",
           "FreeableMemory": "Minimum", "SwapUsage": "Maximum", "CurrItems": "Maximum", "CurrVolatileItems": "Maximum", "DB0AverageTTL": "Average",
           "Evictions": "Sum", "Reclaimed": "Sum", "ErrorCount": "Sum", "EngineCPUUtilization": "Maximum"}
PREFIX = "arn:aws:ecs:us-west-2:237343248947:"
REGISTRY = "237343248947.dkr.ecr.us-west-2.amazonaws.com/oxy/"


def require(ok, message):
    if not ok:
        raise ValueError(message)


def moment(value):
    require(bool(re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", value)), "Exact UTC timestamp required")
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))


def validate(env, now):
    require(env.get("GITHUB_REF") == "refs/heads/main" and env.get("GITHUB_REF_PROTECTED") == "true", "Protected main required")
    require(bool(env.get("GITHUB_ACTOR")) and env.get("GITHUB_TRIGGERING_ACTOR") == env.get("GITHUB_ACTOR"), "Same dispatching operator required")
    for app in ["OXY", "MENTION"]:
        require(bool(re.fullmatch(r"[0-9a-f]{40}", env.get(app + "_SOURCE_SHA", ""))), "Exact deployed source SHA required")
        require(bool(re.fullmatch(r"sha256:[0-9a-f]{64}", env.get(app + "_IMAGE_DIGEST", ""))), "Exact deployed digest required")
    start, end = moment(env.get("FAILURE_START", "")), moment(env.get("FAILURE_END", ""))
    require(dt.timedelta(0) < end - start <= dt.timedelta(minutes=15) and end <= now and now - start <= dt.timedelta(hours=24), "Failure window must be past, <=15 minutes and within last 24 hours")
    return start, end


def redis_host(container, aws):
    plain = [item.get("value") for item in container.get("environment", []) if item.get("name") == "REDIS_URL"]
    secrets = [item.get("valueFrom") for item in container.get("secrets", []) if item.get("name") == "REDIS_URL"]
    require(len(plain) + len(secrets) == 1, "Exactly one REDIS_URL binding required")
    if secrets:
        name = secrets[0]
        if isinstance(name, str) and name.startswith("arn:aws:ssm:us-west-2:237343248947:parameter/"):
            name = name.split(":parameter", 1)[1]
        require(name in SSM_NAMES, "REDIS_URL must use an approved exact SSM parameter")
        reply = aws(["ssm", "get-parameter", "--name", name, "--with-decryption", "--output", "json"])
        value = reply.get("Parameter", {}).get("Value")
    else:
        value = plain[0]
    require(isinstance(value, str), "REDIS_URL binding unavailable")
    try:
        url = urlsplit(value)
        require(url.scheme in {"redis", "rediss"} and bool(url.hostname), "Invalid Redis binding")
        return url.hostname.lower()
    except Exception:
        raise ValueError("Invalid Redis binding") from None


def service_binding(app, sha, digest, aws):
    service = aws(["ecs", "describe-services", "--cluster", "oxy-cluster", "--services", app, "--output", "json"])
    require(not service.get("failures") and len(service.get("services", [])) == 1, "Expected exact service")
    s = service["services"][0]
    require(s.get("status") == "ACTIVE" and 0 < s.get("desiredCount", 0) <= 10 and s.get("runningCount") == s["desiredCount"]
            and s.get("pendingCount") == 0 and len(s.get("deployments", [])) == 1 and s["deployments"][0].get("rolloutState") == "COMPLETED", "Service must be settled")
    definition = s.get("taskDefinition", "")
    require(bool(re.fullmatch(re.escape(PREFIX) + r"task-definition/[A-Za-z0-9_-]+:[0-9]+", definition)), "Invalid task definition")
    image = aws(["ecr", "batch-get-image", "--repository-name", "oxy/" + app, "--image-ids", "imageTag=" + sha, "--output", "json"])
    require(not image.get("failures") and len(image.get("images", [])) == 1 and image["images"][0].get("imageId", {}).get("imageDigest") == digest, "Source image mismatch")
    taskdef = aws(["ecs", "describe-task-definition", "--task-definition", definition, "--query", "taskDefinition", "--output", "json"])
    require(taskdef.get("taskDefinitionArn") == definition, "Task definition mismatch")
    containers = [c for c in taskdef.get("containerDefinitions", []) if c.get("name") == app]
    require(len(containers) == 1 and containers[0].get("image") in {REGISTRY + app + "@" + digest, REGISTRY + app + ":" + sha}, "Container image mismatch")
    listed = aws(["ecs", "list-tasks", "--cluster", "oxy-cluster", "--service-name", app, "--desired-status", "RUNNING", "--output", "json"])
    tasks = listed.get("taskArns", [])
    require(not listed.get("nextToken") and len(tasks) == s["desiredCount"] and len(set(tasks)) == len(tasks)
            and all(re.fullmatch(re.escape(PREFIX) + r"task/oxy-cluster/[0-9a-f]{32}", task) for task in tasks), "Incomplete task list")
    actual = aws(["ecs", "describe-tasks", "--cluster", "oxy-cluster", "--tasks", *tasks, "--output", "json"])
    require(not actual.get("failures") and sorted(t.get("taskArn", "") for t in actual.get("tasks", [])) == sorted(tasks), "Incomplete task descriptions")
    for task in actual["tasks"]:
        matching = [c for c in task.get("containers", []) if c.get("name") == app and c.get("imageDigest") == digest]
        require(task.get("lastStatus") == "RUNNING" and task.get("taskDefinitionArn") == definition and len(matching) == 1, "Deployed task mismatch")
        for override in task.get("overrides", {}).get("containerOverrides", []):
            if override.get("name") == app:
                require(not any(item.get("name") == "REDIS_URL" for item in override.get("environment", [])), "Task overrides Redis routing")
    return {"service": app, "sourceSha": sha, "imageDigest": digest, "taskDefinitionArn": definition, "taskArns": sorted(tasks)}, redis_host(containers[0], aws)


def inspect(env, aws, now):
    start, end = validate(env, now)
    services, hosts = [], []
    for prefix, app in [("OXY", "oxy-api"), ("MENTION", "mention")]:
        service, host = service_binding(app, env[prefix + "_SOURCE_SHA"], env[prefix + "_IMAGE_DIGEST"], aws)
        services.append(service)
        hosts.append(host)
    groups = aws(["elasticache", "describe-replication-groups", "--output", "json"])
    require(not groups.get("Marker"), "Incomplete replication group inventory")
    chosen = [g for g in groups.get("ReplicationGroups", []) if g.get("ReplicationGroupId") in GROUPS]
    require(chosen, "No reviewed Valkey groups found")
    endpoint_map, output, nodes = {}, [], []
    for group in chosen:
        gid = group["ReplicationGroupId"]
        for shard in group.get("NodeGroups", []):
            for key in ["PrimaryEndpoint", "ReaderEndpoint"]:
                address = shard.get(key, {}).get("Address")
                if isinstance(address, str): endpoint_map[address.lower()] = gid
        members = group.get("MemberClusters", [])
        require(0 < len(members) <= 3, "Unexpected cache member count")
        for member in members:
            require(isinstance(member, str) and bool(re.fullmatch(re.escape(gid) + r"-[0-9]+", member)), "Unexpected cache member")
            reply = aws(["elasticache", "describe-cache-clusters", "--cache-cluster-id", member, "--show-cache-node-info", "--output", "json"])
            require(len(reply.get("CacheClusters", [])) == 1, "Incomplete cache cluster")
            cache = reply["CacheClusters"][0]
            require(cache.get("CacheClusterId") == member and cache.get("ReplicationGroupId") == gid, "Cache membership mismatch")
            parameter_group = cache.get("CacheParameterGroup", {}).get("CacheParameterGroupName", "")
            require(bool(re.fullmatch(r"(?:oxy-valkey-[a-z0-9-]+|default\.valkey[0-9.a-z-]+)", parameter_group)), "Unexpected parameter group")
            parameters = aws(["elasticache", "describe-cache-parameters", "--cache-parameter-group-name", parameter_group, "--output", "json"])
            require(not parameters.get("Marker"), "Incomplete parameter readback")
            selected = {p["ParameterName"]: p.get("ParameterValue") for p in parameters.get("Parameters", []) if p.get("ParameterName") in PARAMETERS}
            require("maxmemory-policy" in selected, "Missing configured eviction policy")
            output.append({"replicationGroupId": gid, "cacheClusterId": member, "nodeType": cache.get("CacheNodeType"), "engine": cache.get("Engine"),
                           "engineVersion": cache.get("EngineVersion"), "status": cache.get("CacheClusterStatus"), "parameterGroup": parameter_group,
                           "parameterApplyStatus": cache.get("CacheParameterGroup", {}).get("ParameterApplyStatus"), "parameters": selected})
            require(0 < len(cache.get("CacheNodes", [])) <= 3, "Unexpected node count")
            for node in cache["CacheNodes"]:
                node_id = node.get("CacheNodeId", "")
                require(bool(re.fullmatch(r"[0-9]{4}", node_id)), "Invalid cache node")
                address = node.get("Endpoint", {}).get("Address")
                if isinstance(address, str): endpoint_map[address.lower()] = gid
                nodes.append((member, node_id))
    for service, host in zip(services, hosts):
        require(host in endpoint_map, "Redis binding does not map to a reviewed ElastiCache endpoint")
        service["redisReplicationGroupId"] = endpoint_map[host]
    queries, metadata = [], {}
    for cluster, node in nodes:
        for metric, stat in METRICS.items():
            ident = "m" + str(len(queries))
            metadata[ident] = {"cacheClusterId": cluster, "cacheNodeId": node, "metric": metric, "statistic": stat}
            queries.append({"Id": ident, "MetricStat": {"Metric": {"Namespace": "AWS/ElastiCache", "MetricName": metric,
                "Dimensions": [{"Name": "CacheClusterId", "Value": cluster}, {"Name": "CacheNodeId", "Value": node}]}, "Period": 60, "Stat": stat}, "ReturnData": True})
    require(len(queries) <= 324, "Metric query bound exceeded")
    windows = []
    for name, window_start, window_end in [("last_hour", now - dt.timedelta(hours=1), now), ("failure", start, end)]:
        reply = aws(["cloudwatch", "get-metric-data", "--metric-data-queries", json.dumps(queries), "--start-time", window_start.isoformat(),
                     "--end-time", window_end.isoformat(), "--scan-by", "TimestampAscending", "--max-datapoints", "100800", "--output", "json"])
        require(not reply.get("NextToken"), "Metric data incomplete")
        values, seen = [], set()
        for result in reply.get("MetricDataResults", []):
            ident = result.get("Id")
            require(ident in metadata and ident not in seen and result.get("StatusCode") == "Complete", "Metric response incomplete or unexpected")
            seen.add(ident)
            timestamps, numbers = result.get("Timestamps", []), result.get("Values", [])
            require(len(timestamps) == len(numbers) and len(numbers) <= 61 and all(type(n) in (int, float) and math.isfinite(n) for n in numbers), "Invalid metric values")
            values.append({**metadata[ident], "timestamps": timestamps, "values": numbers, "hasData": bool(numbers)})
        require(seen == set(metadata), "Missing metric results")
        windows.append({"name": name, "start": window_start.isoformat(), "end": window_end.isoformat(), "metrics": values})
    # Re-read routing after metrics; a concurrent rollout invalidates this snapshot.
    for index, (prefix, app) in enumerate([("OXY", "oxy-api"), ("MENTION", "mention")]):
        current, host = service_binding(app, env[prefix + "_SOURCE_SHA"], env[prefix + "_IMAGE_DIGEST"], aws)
        require(current["taskDefinitionArn"] == services[index]["taskDefinitionArn"] and current["taskArns"] == services[index]["taskArns"]
                and host == hosts[index], "Deployment or Redis routing changed during readback")
    return {"operation": "read_redis_capacity", "readOnly": True, "observedAt": now.isoformat(), "services": services, "caches": output, "windows": windows,
            "limitations": ["Missing metric points are unknown, not zero.", "Key counts and TTL metrics do not identify individual keys or prove request causality."]}


def call_aws(args):
    response = subprocess.run(["aws", *args, "--region", "us-west-2", "--cli-connect-timeout", "5", "--cli-read-timeout", "15"], capture_output=True, text=True,
        env={**os.environ, "AWS_PAGER": "", "AWS_MAX_ATTEMPTS": "2"}, timeout=50)
    require(response.returncode == 0, "AWS read failed: " + " ".join(args[:2]))
    return json.loads(response.stdout)


if __name__ == "__main__":
    try:
        report = inspect(os.environ, call_aws, dt.datetime.now(dt.timezone.utc).replace(microsecond=0))
        Path("redis-capacity-readback").mkdir(exist_ok=True)
        Path("redis-capacity-readback/report.json").write_text(json.dumps(report, indent=2) + "\n")
        print("Sanitized Redis capacity readback completed")
    except Exception as error:
        print("Redis readback failed: " + (str(error) if type(error) is ValueError else type(error).__name__), file=sys.stderr)
        sys.exit(1)
