#!/usr/bin/env python3
"""Offline controls: no AWS credentials or network requests are used."""
import importlib.util
import json
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("readback", Path(__file__).with_name("read-external-identity-api-logs.py"))
reader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader)
SHA = "a" * 40
DIGEST = "sha256:" + "b" * 64
TASK = reader.TASK_PREFIX + "c" * 32
DEFINITION = "arn:aws:ecs:us-west-2:237343248947:task-definition/oxy-oxy-api:123"
ACTOR = "https://bird.makeup/users/yanndubs"
ENV = {"GITHUB_REF": "refs/heads/main", "GITHUB_REF_PROTECTED": "true", "GITHUB_ACTOR": "operator", "GITHUB_TRIGGERING_ACTOR": "operator",
       "EXPECTED_SOURCE_SHA": SHA, "EXPECTED_IMAGE_DIGEST": DIGEST, "ACTOR_URI": ACTOR, "TRANSPORT_ACCT": "yanndubs@bird.makeup",
       "WINDOW_START": "2026-09-13T07:48:30Z", "WINDOW_END": "2026-09-13T07:51:00Z"}
NOW = reader.utc_milliseconds("2026-09-13T08:00:00Z")
STAMP = reader.utc_milliseconds("2026-09-13T07:49:04Z")


def log(message, timestamp=STAMP):
    return {"timestamp": timestamp, "message": json.dumps({"msg": message, "authorization": "SECRET", "req": {"headers": {"cookie": "SECRET"}}})}


class AWS:
    def __init__(self, mode="success"):
        self.mode = mode
        self.calls = []
        self.service_reads = 0

    def __call__(self, args):
        self.calls.append(args)
        command = tuple(args[:2])
        if command == ("ecs", "describe-services"):
            self.service_reads += 1
            return {"failures": [], "services": [{"status": "ACTIVE", "desiredCount": 1, "runningCount": 1,
                "pendingCount": 1 if self.mode == "unsettled" else 0,
                "taskDefinition": DEFINITION + "4" if self.mode == "rollout" and self.service_reads > 1 else DEFINITION,
                "deployments": [{"rolloutState": "COMPLETED"}]}]}
        if command == ("ecr", "batch-get-image"):
            assert "imageTag=" + SHA in args
            return {"images": [{"imageId": {"imageDigest": "sha256:" + "d" * 64 if self.mode == "source" else DIGEST}}]}
        if command == ("ecs", "describe-task-definition"):
            return {"taskDefinitionArn": DEFINITION, "containerDefinitions": [{"name": "oxy-api", "image": reader.REGISTRY + "@" + DIGEST,
                "environment": [{"name": "PRIVATE_KEY", "value": "SECRET"}], "secrets": [{"name": "DATABASE_URL", "valueFrom": "SECRET"}],
                "logConfiguration": {"logDriver": "awslogs", "options": {"awslogs-group": "/unrelated" if self.mode == "logs" else "/oxy/ecs", "awslogs-stream-prefix": "oxy-api"}}}]}
        if command == ("ecs", "list-tasks"):
            return {"taskArns": [TASK], **({"nextToken": "more"} if self.mode == "task_paging" else {})}
        if command == ("ecs", "describe-tasks"):
            return {"failures": [], "tasks": [{"taskArn": TASK, "taskDefinitionArn": DEFINITION, "lastStatus": "RUNNING", "startedAt": "2026-09-13T00:00:00Z",
                "containers": [{"name": "oxy-api", "imageDigest": "sha256:" + "e" * 64 if self.mode == "image" else DIGEST}]}]}
        if command == ("logs", "get-log-events"):
            assert args[args.index("--start-time") + 1] == str(reader.utc_milliseconds(ENV["WINDOW_START"]))
            assert args[args.index("--end-time") + 1] == str(reader.utc_milliseconds(ENV["WINDOW_END"]))
            assert args[args.index("--log-stream-name") + 1] == "oxy-api/oxy-api/" + "c" * 32
            if self.mode == "page_limit":
                return {"events": [], "nextForwardToken": str(len(self.calls))}
            if "--next-token" in args:
                return {"events": [log(f"Failed to fetch actor profile {ACTOR}: timeout SECRET")] if self.mode != "empty" else [], "nextForwardToken": "last"}
            if self.mode == "empty":
                return {"events": [], "nextForwardToken": "last"}
            return {"events": [log(f"[Federation] signedFetch got 403 for {ACTOR} — remote rejected our HTTP signature"),
                log("Failed to fetch actor profile https://bird.makeup/users/yanndubs-other: SECRET"),
                log("ApiError [404] NOT_FOUND: External actor could not be verified SECRET"),
                log(f"Failed to fetch actor profile {ACTOR}: SECRET", STAMP - 3600_000),
                log(f"Authorization SECRET actor={ACTOR}"), {"timestamp": STAMP, "message": "SECRET"}], "nextForwardToken": "last"}
        raise AssertionError("Forbidden AWS operation: " + " ".join(command))


class ReadbackControls(unittest.TestCase):
    def test_paginated_exact_selector_sanitized_and_source_verified(self):
        aws = AWS()
        report = reader.readback(ENV, aws, NOW)
        self.assertEqual(report["matchingEvents"], 2)
        self.assertEqual([event["event"] for event in report["events"]], ["signature_rejected", "actor_profile_exception"])
        self.assertEqual(report["events"][1]["errorClass"], "timeout")
        self.assertEqual(report["streams"][0]["pagesRead"], 2)
        self.assertNotIn("SECRET", json.dumps(report))
        self.assertNotIn("PRIVATE_KEY", json.dumps(report))
        self.assertNotIn("authorization", json.dumps(report))

    def test_invalid_controls_fail_before_aws(self):
        for patch in [{"GITHUB_REF": "refs/heads/evil"}, {"GITHUB_REF_PROTECTED": "false"}, {"GITHUB_TRIGGERING_ACTOR": "other"},
                      {"EXPECTED_SOURCE_SHA": "main"}, {"EXPECTED_IMAGE_DIGEST": "latest"}, {"ACTOR_URI": "https://evil.example/users/yanndubs"},
                      {"ACTOR_URI": ACTOR + "?token=SECRET"}, {"TRANSPORT_ACCT": "other@bird.makeup"},
                      {"WINDOW_START": "2026-09-13T07:30:00Z"}, {"WINDOW_START": "2026-09-12T00:00:00Z"},
                      {"WINDOW_END": "2026-09-13T09:00:00Z"}, {"WINDOW_END": ENV["WINDOW_START"]}]:
            with self.subTest(patch=patch):
                aws = AWS()
                with self.assertRaises(ValueError):
                    reader.readback({**ENV, **patch}, aws, NOW)
                self.assertEqual(aws.calls, [])

    def test_unverified_deployment_never_reads_logs(self):
        for mode in ["unsettled", "source", "image", "logs", "task_paging"]:
            with self.subTest(mode=mode):
                aws = AWS(mode)
                with self.assertRaises(ValueError):
                    reader.readback(ENV, aws, NOW)
                self.assertFalse(any(call[0] == "logs" for call in aws.calls))

    def test_rollout_during_collection_fails(self):
        with self.assertRaisesRegex(ValueError, "Deployment changed"):
            reader.readback(ENV, AWS("rollout"), NOW)

    def test_no_matches_remains_inconclusive(self):
        report = reader.readback(ENV, AWS("empty"), NOW)
        self.assertEqual(report["matchingEvents"], 0)
        self.assertTrue(report["silentNullBranchesPossible"])
        self.assertIn("cannot rule out", report["interpretation"])

    def test_page_limit_never_publishes_partial_success(self):
        with self.assertRaisesRegex(ValueError, "paging bound exceeded"):
            reader.readback(ENV, AWS("page_limit"), NOW)

    def test_typed_resolution_event_is_strictly_projected(self):
        config = reader.configuration(ENV, NOW)
        message = "Federation identity resolution failed"
        record = {"operation": "resolve_external_identity", "phase": "actor_fetch", "reason": "http_status", "httpStatus": 429,
                  "actorUri": ACTOR, "acct": ENV["TRANSPORT_ACCT"], "message": "SECRET", "authorization": "SECRET"}
        event = reader.classify(message, config, record)
        self.assertEqual(event, {"event": "resolution_failed", "phase": "actor_fetch", "reason": "http_status", "httpStatus": 429})
        for patch in [{"operation": "arbitrary"}, {"phase": {}}, {"reason": []}, {"phase": "SECRET"}, {"reason": "SECRET"}, {"actorUri": ACTOR + "-other"},
                      {"acct": "other@bird.makeup"}, {"httpStatus": True}, {"httpStatus": "SECRET"}, {"httpStatus": 999},
                      {"actorUri": None, "acct": None}]:
            self.assertIsNone(reader.classify(message, config, {**record, **patch}))

    def test_freeform_error_is_never_returned(self):
        config = reader.configuration(ENV, NOW)
        event = reader.classify(f"Federation fetch failed for {ACTOR}: SECRET", config)
        self.assertEqual(event, {"event": "federation_fetch_exception", "errorClass": "unclassified"})
        self.assertIsNone(reader.classify(f"Failed to fetch actor profile {ACTOR}-other: timeout", config))
        self.assertEqual(reader.classify(f"[Federation] signedFetch got 503 for {ACTOR}, retrying unsigned", config)["httpStatus"], 503)
        self.assertEqual(reader.classify(f"Federation URL rejected by SSRF guard (SECRET): {ACTOR}", config), {"event": "ssrf_rejected"})


if __name__ == "__main__":
    unittest.main()
