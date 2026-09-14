#!/usr/bin/env python3
import importlib.util
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("reader", Path(__file__).with_name("read-redis-capacity.py"))
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)
SHA, DIGEST = "a" * 40, "sha256:" + "b" * 64
ENV = {"GITHUB_REF": "refs/heads/main", "GITHUB_REF_PROTECTED": "true", "GITHUB_ACTOR": "operator", "GITHUB_TRIGGERING_ACTOR": "operator",
       "OXY_SOURCE_SHA": SHA, "OXY_IMAGE_DIGEST": DIGEST, "MENTION_SOURCE_SHA": SHA, "MENTION_IMAGE_DIGEST": DIGEST,
       "FAILURE_START": "2026-09-13T08:05:50Z", "FAILURE_END": "2026-09-13T08:06:20Z"}
NOW = r.moment("2026-09-13T08:15:00Z")
DEFS = {app: r.PREFIX + "task-definition/oxy-" + app + ":1" for app in ["oxy-api", "mention"]}
TASKS = {app: r.PREFIX + "task/oxy-cluster/" + char * 32 for app, char in [("oxy-api", "c"), ("mention", "d")]}


class AWS:
    def __init__(self, mode="success"):
        self.mode, self.calls, self.service_reads = mode, [], 0

    def __call__(self, args):
        self.calls.append(args)
        command = tuple(args[:2])
        if command == ("ecs", "describe-services"):
            app = args[args.index("--services") + 1]
            self.service_reads += 1
            return {"services": [{"status": "ACTIVE", "desiredCount": 1, "runningCount": 1, "pendingCount": 0,
                                  "taskDefinition": DEFS[app], "deployments": [{"rolloutState": "COMPLETED"}]}]}
        if command == ("ecr", "batch-get-image"):
            return {"images": [{"imageId": {"imageDigest": "sha256:wrong" if self.mode == "image" else DIGEST}}]}
        if command == ("ecs", "describe-task-definition"):
            definition = args[args.index("--task-definition") + 1]
            app = next(app for app in DEFS if DEFS[app] == definition)
            name = "/oxy/other/SECRET" if self.mode == "ssm" else "/oxy/_shared/REDIS_URL"
            return {"taskDefinitionArn": definition, "containerDefinitions": [{"name": app, "image": r.REGISTRY + app + "@" + DIGEST,
                "secrets": [{"name": "REDIS_URL", "valueFrom": name}, {"name": "PRIVATE_KEY", "valueFrom": "SECRET"}]}]}
        if command == ("ecs", "list-tasks"):
            app = args[args.index("--service-name") + 1]
            return {"taskArns": [TASKS[app]]}
        if command == ("ecs", "describe-tasks"):
            task = args[args.index("--tasks") + 1]
            app = next(app for app in TASKS if TASKS[app] == task)
            return {"tasks": [{"taskArn": task, "taskDefinitionArn": DEFS[app], "lastStatus": "RUNNING", "containers": [{"name": app, "imageDigest": DIGEST}]}]}
        if command == ("ssm", "get-parameter"):
            host = "unknown.private" if self.mode == "host" or (self.mode == "drift" and self.service_reads > 2) else "cache.private"
            return {"Parameter": {"Value": "rediss://SECRET_USERNAME:SECRET_PASSWORD@" + host + ":6379/0"}}
        if command == ("elasticache", "describe-replication-groups"):
            return {"ReplicationGroups": [{"ReplicationGroupId": "oxy-valkey-2", "MemberClusters": ["oxy-valkey-2-001"], "NodeGroups": [{"PrimaryEndpoint": {"Address": "cache.private"}}]}]}
        if command == ("elasticache", "describe-cache-clusters"):
            return {"CacheClusters": [{"CacheClusterId": "oxy-valkey-2-001", "ReplicationGroupId": "oxy-valkey-2", "CacheNodeType": "cache.t4g.small",
                "Engine": "valkey", "EngineVersion": "8.0.1", "CacheClusterStatus": "available",
                "CacheParameterGroup": {"CacheParameterGroupName": "oxy-valkey-volatile-lru", "ParameterApplyStatus": "in-sync"},
                "CacheNodes": [{"CacheNodeId": "0001", "Endpoint": {"Address": "node.private"}}]}]}
        if command == ("elasticache", "describe-cache-parameters"):
            return {"Parameters": [{"ParameterName": "maxmemory-policy", "ParameterValue": "volatile-lru"}, {"ParameterName": "arbitrary", "ParameterValue": "SECRET"}]}
        if command == ("cloudwatch", "get-metric-data"):
            queries = json.loads(args[args.index("--metric-data-queries") + 1])
            assert {q["MetricStat"]["Metric"]["MetricName"] for q in queries} == set(r.METRICS)
            return {"MetricDataResults": [{"Id": q["Id"], "StatusCode": "PartialData" if self.mode == "partial" else "Complete",
                "Label": "SECRET", "Timestamps": [] if self.mode == "empty" else ["2026-09-13T08:06:00Z"],
                "Values": [] if self.mode == "empty" else [99.0]} for q in queries]}
        raise AssertionError("Forbidden AWS call: " + " ".join(command))


class Controls(unittest.TestCase):
    def test_routing_and_metrics_without_secret_or_hostname(self):
        aws = AWS()
        result = r.inspect(ENV, aws, NOW)
        self.assertEqual([s["redisReplicationGroupId"] for s in result["services"]], ["oxy-valkey-2"] * 2)
        self.assertEqual(result["caches"][0]["parameters"], {"maxmemory-policy": "volatile-lru"})
        self.assertEqual(len(result["windows"]), 2)
        for forbidden in ["SECRET", "cache.private", "node.private", "rediss://", "PRIVATE_KEY"]:
            self.assertNotIn(forbidden, json.dumps(result))

    def test_invalid_inputs_make_no_aws_calls(self):
        for patch in [{"GITHUB_REF": "refs/heads/evil"}, {"GITHUB_TRIGGERING_ACTOR": "other"}, {"OXY_SOURCE_SHA": "main"},
                      {"MENTION_IMAGE_DIGEST": "latest"}, {"FAILURE_START": "2026-09-13T07:00:00Z"}, {"FAILURE_END": "2026-09-13T09:00:00Z"}]:
            aws = AWS()
            with self.assertRaises(ValueError): r.inspect({**ENV, **patch}, aws, NOW)
            self.assertEqual(aws.calls, [])

    def test_wrong_image_and_unapproved_ssm_never_read_secret(self):
        for mode in ["image", "ssm"]:
            aws = AWS(mode)
            with self.assertRaises(ValueError): r.inspect(ENV, aws, NOW)
            self.assertFalse(any(call[:2] == ["ssm", "get-parameter"] for call in aws.calls))

    def test_unknown_host_partial_metrics_and_drift_fail_closed(self):
        for mode in ["host", "partial", "drift"]:
            with self.assertRaises(ValueError): r.inspect(ENV, AWS(mode), NOW)

    def test_missing_datapoints_are_unknown(self):
        result = r.inspect(ENV, AWS("empty"), NOW)
        self.assertTrue(all(not metric["hasData"] and metric["values"] == [] for window in result["windows"] for metric in window["metrics"]))


if __name__ == "__main__": unittest.main()
