import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { shapeHash } from "../.github/scripts/guard-quiesced-deploy.mjs";

const root = resolve(import.meta.dirname, "..");
const scratch = mkdtempSync(join(tmpdir(), "quiesced-shell-"));
const old =
	"arn:aws:ecs:us-west-2:237343248947:task-definition/oxy-oxy-api:692";
const next = old.replace(":692", ":693");
const task = `arn:aws:ecs:us-west-2:237343248947:task/oxy-cluster/${"a".repeat(32)}`;
const target =
	"arn:aws:elasticloadbalancing:us-west-2:237343248947:targetgroup/oxy-api/0123456789abcdef";
const previousImage = `237343248947.dkr.ecr.us-west-2.amazonaws.com/oxy/oxy-api@sha256:${"1".repeat(64)}`;
const finalImage = previousImage.replace("1".repeat(64), "2".repeat(64));
const definition = {
	taskDefinitionArn: old,
	family: "oxy-oxy-api",
	containerDefinitions: [
		{
			name: "oxy-api",
			image: previousImage,
			environment: [{ name: "PUBLIC_CONFIG", value: "unchanged" }],
			secrets: [],
		},
	],
};
const plan = {
	schemaVersion: 1,
	region: "us-west-2",
	cluster: "oxy-cluster",
	service: "oxy-api",
	container: "oxy-api",
	previousTaskDefinition: old,
	previousImage,
	previousShapeSha256: shapeHash(definition),
	finalImage,
	sourceSha: "c".repeat(40),
	restoreCount: 2,
	previousTasks: [task],
	targetGroups: [target],
	scaler: null,
};
const binary = join(scratch, "bin");
mkdirSync(binary);
writeFileSync(
	join(binary, "aws"),
	`#!/usr/bin/env node
const fs=require('node:fs');
const args=process.argv.slice(2), dir=process.env.FIXTURE_DIR;
const value=flag=>args.includes(flag)?args[args.indexOf(flag)+1]:undefined;
const p=JSON.parse(fs.readFileSync(dir+'/plan.json'));
const def=JSON.parse(fs.readFileSync(dir+'/definition.json'));
const next=p.previousTaskDefinition.replace(':692',':693');
let s=JSON.parse(fs.readFileSync(dir+'/state.json'));
const emit=x=>process.stdout.write(typeof x==='string'?x:JSON.stringify(x));
const event=x=>fs.appendFileSync(dir+'/events.jsonl',JSON.stringify(x)+'\\n');
const save=()=>fs.writeFileSync(dir+'/state.json',JSON.stringify(s));
const newArn=p.previousTasks[0].replace('a'.repeat(32),'b'.repeat(32));
const service=()=>({failures:[],services:[{serviceName:p.service,status:'ACTIVE',taskDefinition:s.td,
desiredCount:s.count,runningCount:s.count,pendingCount:0,loadBalancers:[{targetGroupArn:p.targetGroups[0]}],
networkConfiguration:{awsvpcConfiguration:{subnets:['fixture'],securityGroups:['fixture'],assignPublicIp:'DISABLED'}},
launchType:'FARGATE',deployments:[{id:'new-deploy',status:'PRIMARY',taskDefinition:s.td,
rolloutState:s.started&&process.env.FIXTURE_FAIL==='true'?'FAILED':'COMPLETED',desiredCount:s.count,runningCount:s.count,pendingCount:0}]}]});
switch(args[0]+' '+args[1]) {
case 'ecs describe-services':emit(service());break;
case 'ecs describe-task-definition':{
 const requested=value('--task-definition');
 const result=requested===next?{...JSON.parse(fs.readFileSync(dir+'/registered.json')),taskDefinitionArn:next}:def;
 emit(args.includes('--query')?result:{taskDefinition:result});break;}
case 'ecs list-tasks':emit({taskArns:value('--desired-status')==='RUNNING'?(s.count?[newArn]:[]):s.started?[...p.previousTasks,newArn]:p.previousTasks});break;
case 'ecs describe-tasks':{
 const ids=args.slice(args.indexOf('--tasks')+1).filter(x=>x.startsWith('arn:'));
 emit({failures:[],tasks:ids.map(arn=>({taskArn:arn,group:'service:'+p.service,
 taskDefinitionArn:arn===newArn?next:p.previousTaskDefinition,lastStatus:arn===newArn&&s.count?'RUNNING':'STOPPED',
 containers:[{name:p.container,lastStatus:'STOPPED',exitCode:0}]}))});break;}
case 'elbv2 describe-target-health':emit({TargetHealthDescriptions:[]});break;
case 'application-autoscaling describe-scalable-targets':emit({ScalableTargets:[]});break;
case 'application-autoscaling describe-scheduled-actions':emit({ScheduledActions:[]});break;
case 'ecs register-task-definition':{
 const rendered=JSON.parse(fs.readFileSync(value('--cli-input-json').replace('file://','')));
 if(rendered.containerDefinitions[0].image!==p.finalImage||rendered.containerDefinitions[0].environment[0].value!=='unchanged')process.exit(2);
 fs.writeFileSync(dir+'/registered.json',JSON.stringify(rendered));event({op:'register',td:next});emit(next);break;}
case 'ecs run-task':event({op:'migration'});emit({failures:[],tasks:[{taskArn:p.previousTasks[0].replace('a'.repeat(32),'d'.repeat(32))}]});break;
case 'ecs update-service':{
 const td=value('--task-definition'),count=Number(value('--desired-count'));
 const config=args.includes('--deployment-configuration')?JSON.parse(value('--deployment-configuration')):null;
 if(td){s.td=td;s.started=true;} s.count=count;save();event({op:'update',td:td||null,count,autoRollback:config?.deploymentCircuitBreaker.rollback});emit({service:service().services[0]});break;}
default:process.stderr.write('Unexpected fixture request');process.exit(3);
}
`,
	{ mode: 0o755 },
);
const guard = join(scratch, "head.sh");
writeFileSync(guard, "#!/usr/bin/env bash\nexit 0\n");
let count = 0;
function run(
	name,
	{ maintenance = true, failure = false, drift = false } = {},
) {
	const dir = join(scratch, name);
	mkdirSync(dir);
	const bytes = JSON.stringify(plan);
	writeFileSync(join(dir, "plan.json"), bytes);
	writeFileSync(join(dir, "definition.json"), JSON.stringify(definition));
	writeFileSync(
		join(dir, "state.json"),
		JSON.stringify({ td: drift ? next : old, count: 0, started: false }),
	);
	writeFileSync(join(dir, "events.jsonl"), "");
	const worker = join(dir, "worker.sh");
	writeFileSync(
		worker,
		`#!/usr/bin/env bash\necho '{"op":"worker"}' >> '${dir}/events.jsonl'\n`,
	);
	const env = {
		PATH: `${binary}:${process.env.PATH}`,
		TMPDIR: scratch,
		AWS_REGION: "us-west-2",
		CLUSTER: "oxy-cluster",
		APP: "oxy-api",
		IMAGE_URI: finalImage,
		FIXTURE_DIR: dir,
		FIXTURE_FAIL: String(failure),
		MAX_WAIT_SECS: "2",
		POLL_INTERVAL: "1",
		RUN_MIGRATIONS: "true",
		PRE_ROLLOUT_SCRIPT: worker,
		DEPLOY_HEAD_GUARD_SCRIPT: guard,
	};
	if (maintenance)
		Object.assign(env, {
			DEPLOY_SHA: plan.sourceSha,
			QUIESCED_DEPLOY_PLAN_PATH: join(dir, "plan.json"),
			QUIESCED_DEPLOY_PLAN_SHA256: createHash("sha256")
				.update(bytes)
				.digest("hex"),
		});
	const result = spawnSync("bash", [".github/scripts/deploy-ecs-image.sh"], {
		cwd: root,
		env,
		encoding: "utf8",
		timeout: 30000,
	});
	const events = readFileSync(join(dir, "events.jsonl"), "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map(JSON.parse);
	const final = JSON.parse(readFileSync(join(dir, "state.json")));
	return { result, events, final };
}
try {
	const good = run("good");
	assert.equal(good.result.status, 0, good.result.stdout + good.result.stderr);
	count++;
	assert.deepEqual(
		good.events.map((x) => x.op),
		["register", "migration", "worker", "update"],
	);
	count++;
	assert.equal(good.events.at(-1).td, next);
	assert.equal(good.events.at(-1).count, 2);
	assert.equal(good.events.at(-1).autoRollback, false);
	count++;
	const failure = run("failure", { failure: true });
	assert.notEqual(failure.result.status, 0);
	count++;
	assert.equal(failure.final.count, 0);
	assert.equal(failure.final.td, next);
	count++;
	assert.ok(
		failure.result.stdout.includes("old bootstrap was not restored"),
		failure.result.stdout + failure.result.stderr,
	);
	count++;
	assert.ok(
		failure.events.filter((x) => x.op === "update").every((x) => x.td !== old),
	);
	count++;
	const normal = run("normal0", { maintenance: false });
	assert.notEqual(normal.result.status, 0);
	assert.deepEqual(normal.events, []);
	count++;
	const drift = run("drift", { drift: true });
	assert.notEqual(drift.result.status, 0);
	assert.deepEqual(drift.events, []);
	count++;
	console.log(
		`Quiesced canonical shell: ${count} checks PASS (mock AWS CLI; real shell, migration/worker/update ordering, failure stopped).`,
	);
} finally {
	rmSync(scratch, { recursive: true });
}
