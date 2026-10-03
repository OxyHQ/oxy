import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function canonical(value) {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map((key) => [key, canonical(value[key])]),
		);
	}
	return value;
}
export function shapeHash(definition) {
	const shape = { ...definition };
	for (const key of [
		"taskDefinitionArn",
		"revision",
		"status",
		"requiresAttributes",
		"compatibilities",
		"registeredAt",
		"registeredBy",
	])
		delete shape[key];
	return createHash("sha256")
		.update(JSON.stringify(canonical(shape)))
		.digest("hex");
}

export function assertFinalDefinition(plan, definition) {
	const copy = structuredClone(definition);
	const containers = copy.containerDefinitions.filter(
		(item) => item.name === plan.container,
	);
	assert.equal(containers.length, 1);
	assert.equal(containers[0].image, plan.finalImage);
	containers[0].image = plan.previousImage;
	assert.equal(shapeHash(copy), plan.previousShapeSha256);
	return true;
}

export function validatePlan(plan, context) {
	assert.deepEqual(
		Object.keys(plan).sort(),
		[
			"schemaVersion",
			"region",
			"cluster",
			"service",
			"container",
			"previousTaskDefinition",
			"previousImage",
			"previousShapeSha256",
			"finalImage",
			"sourceSha",
			"restoreCount",
			"previousTasks",
			"targetGroups",
			"scaler",
		].sort(),
	);
	assert.equal(plan.schemaVersion, 1);
	assert.equal(plan.service, "oxy-api");
	assert.equal(plan.container, "oxy-api");
	assert.equal(plan.region, "us-west-2");
	assert.equal(plan.cluster, "oxy-cluster");
	for (const key of ["region", "cluster", "service", "container"])
		assert.equal(plan[key], context[key]);
	assert.match(
		plan.previousTaskDefinition,
		/^arn:aws:ecs:us-west-2:237343248947:task-definition\/oxy-oxy-api:[1-9][0-9]*$/,
	);
	assert.match(plan.previousShapeSha256, /^[0-9a-f]{64}$/);
	assert.match(plan.sourceSha, /^[0-9a-f]{40}$/);
	assert.equal(plan.sourceSha, context.sourceSha);
	assert.equal(plan.finalImage, context.image);
	for (const image of [plan.previousImage, plan.finalImage]) {
		assert.match(
			image,
			/^237343248947\.dkr\.ecr\.us-west-2\.amazonaws\.com\/oxy\/oxy-api@sha256:[0-9a-f]{64}$/,
		);
	}
	assert.notEqual(plan.previousImage, plan.finalImage);
	assert.ok(
		Number.isSafeInteger(plan.restoreCount) &&
			plan.restoreCount > 0 &&
			plan.restoreCount <= 6,
	);
	assert.ok(
		Array.isArray(plan.previousTasks) &&
			plan.previousTasks.length > 0 &&
			plan.previousTasks.length <= 100,
	);
	assert.equal(new Set(plan.previousTasks).size, plan.previousTasks.length);
	for (const task of plan.previousTasks)
		assert.match(
			task,
			/^arn:aws:ecs:us-west-2:237343248947:task\/oxy-cluster\/[0-9a-f]{32}$/,
		);
	assert.ok(
		Array.isArray(plan.targetGroups) &&
			plan.targetGroups.length > 0 &&
			plan.targetGroups.length <= 10,
	);
	assert.equal(new Set(plan.targetGroups).size, plan.targetGroups.length);
	for (const target of plan.targetGroups)
		assert.match(
			target,
			/^arn:aws:elasticloadbalancing:us-west-2:237343248947:targetgroup\/[A-Za-z0-9-]+\/[0-9a-f]+$/,
		);
	if (plan.scaler !== null) {
		assert.deepEqual(Object.keys(plan.scaler).sort(), ["max", "min"]);
		assert.ok(
			Number.isSafeInteger(plan.scaler.min) &&
				Number.isSafeInteger(plan.scaler.max),
		);
		assert.ok(
			plan.scaler.min >= 0 &&
				plan.scaler.max >= plan.scaler.min &&
				plan.scaler.max <= 6,
		);
		assert.ok(
			plan.restoreCount >= plan.scaler.min &&
				plan.restoreCount <= plan.scaler.max,
		);
	}
	return plan;
}

export function assertQuiesced(plan, snapshot) {
	assert.deepEqual(snapshot.service.failures, []);
	assert.equal(snapshot.service.services.length, 1);
	const service = snapshot.service.services[0];
	assert.equal(service.serviceName, plan.service);
	assert.equal(service.status, "ACTIVE");
	assert.equal(service.taskDefinition, plan.previousTaskDefinition);
	for (const count of ["desiredCount", "runningCount", "pendingCount"])
		assert.equal(service[count], 0);
	assert.ok(
		Array.isArray(service.deployments) && service.deployments.length > 0,
	);
	for (const deployment of service.deployments) {
		for (const count of ["desiredCount", "runningCount", "pendingCount"])
			assert.equal(deployment[count], 0);
	}
	assert.deepEqual(snapshot.running.taskArns, []);
	assert.equal(snapshot.running.nextToken, undefined);
	assert.equal(snapshot.stopped.nextToken, undefined);
	assert.deepEqual(snapshot.tasks.failures, []);
	assert.deepEqual(
		snapshot.tasks.tasks.map((task) => task.taskArn).sort(),
		[...new Set([...plan.previousTasks, ...snapshot.stopped.taskArns])].sort(),
	);
	for (const task of snapshot.tasks.tasks) {
		assert.equal(task.group, `service:${plan.service}`);
		if (plan.previousTasks.includes(task.taskArn))
			assert.equal(task.taskDefinitionArn, plan.previousTaskDefinition);
		assert.equal(task.lastStatus, "STOPPED");
	}
	assert.equal(
		snapshot.definition.taskDefinitionArn,
		plan.previousTaskDefinition,
	);
	assert.equal(shapeHash(snapshot.definition), plan.previousShapeSha256);
	const containers = snapshot.definition.containerDefinitions.filter(
		(item) => item.name === plan.container,
	);
	assert.equal(containers.length, 1);
	assert.equal(containers[0].image, plan.previousImage);
	const groups = [
		...new Set(
			(service.loadBalancers ?? []).map((entry) => entry.targetGroupArn),
		),
	].sort();
	assert.deepEqual(groups, [...plan.targetGroups].sort());
	assert.deepEqual(Object.keys(snapshot.targets).sort(), groups);
	for (const target of Object.values(snapshot.targets))
		assert.deepEqual(target.TargetHealthDescriptions, []);
	assert.equal(snapshot.scalers.NextToken, undefined);
	assert.equal(snapshot.scheduled.NextToken, undefined);
	assert.deepEqual(snapshot.scheduled.ScheduledActions, []);
	const scalers = snapshot.scalers.ScalableTargets;
	if (plan.scaler === null) assert.deepEqual(scalers, []);
	else {
		assert.equal(scalers.length, 1);
		const scaler = scalers[0];
		assert.equal(scaler.ResourceId, `service/${plan.cluster}/${plan.service}`);
		assert.equal(scaler.ScalableDimension, "ecs:service:DesiredCount");
		assert.equal(scaler.MinCapacity, plan.scaler.min);
		assert.equal(scaler.MaxCapacity, plan.scaler.max);
		assert.deepEqual(scaler.SuspendedState, {
			DynamicScalingInSuspended: true,
			DynamicScalingOutSuspended: true,
			ScheduledScalingSuspended: true,
		});
	}
	return true;
}

function aws(...args) {
	return JSON.parse(
		execFileSync(
			"aws",
			[...args, "--region", "us-west-2", "--output", "json"],
			{
				encoding: "utf8",
				maxBuffer: 4 * 1024 * 1024,
				timeout: 30_000,
				stdio: ["ignore", "pipe", "pipe"],
			},
		),
	);
}
export function readSnapshot(plan, read = aws) {
	const resource = `service/${plan.cluster}/${plan.service}`;
	const lists = {};
	for (const status of ["RUNNING", "STOPPED"]) {
		const page = read(
			"ecs",
			"list-tasks",
			"--cluster",
			plan.cluster,
			"--service-name",
			plan.service,
			"--desired-status",
			status,
		);
		assert.equal(page.nextToken, undefined);
		assert.ok(Array.isArray(page.taskArns));
		assert.equal(new Set(page.taskArns).size, page.taskArns.length);
		lists[status] = page;
	}
	const arns = [
		...new Set([
			...plan.previousTasks,
			...lists.RUNNING.taskArns,
			...lists.STOPPED.taskArns,
		]),
	];
	assert.ok(arns.length <= 500);
	const tasks = { failures: [], tasks: [] };
	for (let offset = 0; offset < arns.length; offset += 100) {
		const requested = arns.slice(offset, offset + 100);
		const page = read(
			"ecs",
			"describe-tasks",
			"--cluster",
			plan.cluster,
			"--tasks",
			...requested,
		);
		assert.deepEqual(page.failures, []);
		assert.deepEqual(
			page.tasks.map((task) => task.taskArn).sort(),
			[...requested].sort(),
		);
		tasks.tasks.push(...page.tasks);
	}
	return {
		service: read(
			"ecs",
			"describe-services",
			"--cluster",
			plan.cluster,
			"--services",
			plan.service,
		),
		running: lists.RUNNING,
		stopped: lists.STOPPED,
		tasks,
		definition: read(
			"ecs",
			"describe-task-definition",
			"--task-definition",
			plan.previousTaskDefinition,
		).taskDefinition,
		targets: Object.fromEntries(
			plan.targetGroups.map((group) => [
				group,
				read("elbv2", "describe-target-health", "--target-group-arn", group),
			]),
		),
		scalers: read(
			"application-autoscaling",
			"describe-scalable-targets",
			"--service-namespace",
			"ecs",
			"--resource-ids",
			resource,
		),
		scheduled: read(
			"application-autoscaling",
			"describe-scheduled-actions",
			"--service-namespace",
			"ecs",
			"--resource-id",
			resource,
		),
	};
}

// Remember every task of this attempted new revision, including desiredSTOPPED
// tasks that are still STOPPING. Counters/list desiredRUNNING alone are insufficient.
export function recordAttemptTasks(plan, newDefinition, file, read = aws) {
	assert.match(
		newDefinition,
		/^arn:aws:ecs:us-west-2:237343248947:task-definition\/oxy-oxy-api:[1-9][0-9]*$/,
	);
	assert.notEqual(newDefinition, plan.previousTaskDefinition);
	const remembered = existsSync(file)
		? JSON.parse(readFileSync(file, "utf8"))
		: [...plan.previousTasks];
	const listed = [];
	for (const status of ["RUNNING", "STOPPED"]) {
		const page = read(
			"ecs",
			"list-tasks",
			"--cluster",
			plan.cluster,
			"--service-name",
			plan.service,
			"--desired-status",
			status,
		);
		assert.equal(page.nextToken, undefined);
		listed.push(...page.taskArns);
	}
	const arns = [...new Set(listed)];
	assert.ok(arns.length <= 500);
	for (let offset = 0; offset < arns.length; offset += 100) {
		const page = read(
			"ecs",
			"describe-tasks",
			"--cluster",
			plan.cluster,
			"--tasks",
			...arns.slice(offset, offset + 100),
		);
		assert.deepEqual(page.failures, []);
		assert.deepEqual(
			page.tasks.map((task) => task.taskArn).sort(),
			arns.slice(offset, offset + 100).sort(),
		);
		for (const task of page.tasks) {
			assert.equal(task.group, `service:${plan.service}`);
			if (task.lastStatus !== "STOPPED")
				assert.ok(
					[plan.previousTaskDefinition, newDefinition].includes(
						task.taskDefinitionArn,
					),
				);
			if (
				[plan.previousTaskDefinition, newDefinition].includes(
					task.taskDefinitionArn,
				)
			)
				remembered.push(task.taskArn);
		}
	}
	const tasks = [...new Set(remembered)].sort();
	assert.ok(tasks.length <= 100);
	writeFileSync(file, JSON.stringify(tasks), { mode: 0o600 });
	return tasks;
}

export function assertRecoveryStopped(
	plan,
	newDefinition,
	tracked,
	read = aws,
) {
	const snapshot = readSnapshot(plan, read);
	const service = snapshot.service.services[0];
	assert.ok(
		service &&
			[plan.previousTaskDefinition, newDefinition].includes(
				service.taskDefinition,
			),
	);
	// Common quiescence checks still examine actual counts, TGs, old tasks,
	// baseline config and suspended scalers. Only the accepted service TD differs.
	assertQuiesced(plan, {
		...snapshot,
		service: {
			...snapshot.service,
			services: [{ ...service, taskDefinition: plan.previousTaskDefinition }],
		},
	});
	const result = read(
		"ecs",
		"describe-tasks",
		"--cluster",
		plan.cluster,
		"--tasks",
		...tracked,
	);
	assert.deepEqual(result.failures, []);
	assert.deepEqual(
		result.tasks.map((task) => task.taskArn).sort(),
		[...tracked].sort(),
	);
	for (const task of result.tasks) {
		assert.equal(task.group, `service:${plan.service}`);
		assert.ok(
			[plan.previousTaskDefinition, newDefinition].includes(
				task.taskDefinitionArn,
			),
		);
		assert.equal(task.lastStatus, "STOPPED");
	}
	return true;
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	try {
		const validateInput = process.argv[2] === "--validate-input";
		const bytes = validateInput
			? Buffer.from(process.env.QUIESCED_DEPLOY_PLAN_JSON ?? "")
			: readFileSync(process.env.QUIESCED_DEPLOY_PLAN_PATH);
		assert.ok(bytes.length <= 128 * 1024);
		assert.equal(
			createHash("sha256").update(bytes).digest("hex"),
			process.env.QUIESCED_DEPLOY_PLAN_SHA256,
		);
		const parsed = JSON.parse(bytes);
		const plan = validatePlan(parsed, {
			region: process.env.AWS_REGION,
			cluster: process.env.CLUSTER,
			service: process.env.APP,
			container: process.env.CONTAINER_NAME ?? process.env.APP,
			sourceSha: process.env.DEPLOY_SHA,
			image: validateInput ? parsed.finalImage : process.env.IMAGE_URI,
		});
		if (validateInput) {
			assert.equal(process.env.GITHUB_REF, "refs/heads/main");
			assert.equal(process.env.GITHUB_EVENT_NAME, "workflow_dispatch");
			assert.equal(process.env.GITHUB_REPOSITORY, "OxyHQ/oxy");
			assert.notEqual(process.env.ISSUER_IMAGE_ONLY, "true");
			const { readCommittedPolicyStatus } = await import(
				"../../scripts/forge-audit-policy.mjs"
			);
			assert.equal(readCommittedPolicyStatus(), "ACTIVE");
			process.stdout.write(
				"Quiesced deployment input valid; live preflight is still required.\n",
			);
			process.exit(0);
		}
		if (process.argv[2] === "--assert-rendered") {
			assertFinalDefinition(
				plan,
				JSON.parse(readFileSync(process.argv[3], "utf8")),
			);
			process.stdout.write(
				"Final definition preserves the reviewed configuration; only the image changes.\n",
			);
			process.exit(0);
		}
		if (process.argv[2] === "--assert-registered") {
			assert.match(
				process.argv[3],
				/^arn:aws:ecs:us-west-2:237343248947:task-definition\/oxy-oxy-api:[1-9][0-9]*$/,
			);
			assert.notEqual(process.argv[3], plan.previousTaskDefinition);
			const definition = aws(
				"ecs",
				"describe-task-definition",
				"--task-definition",
				process.argv[3],
			).taskDefinition;
			assert.equal(definition.taskDefinitionArn, process.argv[3]);
			assertFinalDefinition(plan, definition);
			process.stdout.write(
				"Registered final definition readback matches the reviewed image/configuration.\n",
			);
			process.exit(0);
		}
		if (["--record-tasks", "--assert-shutdown"].includes(process.argv[2])) {
			const tracked = recordAttemptTasks(
				plan,
				process.argv[3],
				process.argv[4],
			);
			if (process.argv[2] === "--assert-shutdown")
				assertRecoveryStopped(plan, process.argv[3], tracked);
			process.stdout.write(
				`Maintenance task set checked: ${tracked.length}.\n`,
			);
			process.exit(0);
		}
		assertQuiesced(plan, readSnapshot(plan));
		// Only the caller's public numeric count is emitted. AWS data, env and secrets never leave this guard.
		process.stdout.write(`${plan.restoreCount}\n`);
	} catch {
		process.stderr.write(
			"Quiesced deployment check failed; shutdown/readback is not confirmed.\n",
		);
		process.exitCode = 1;
	}
}
