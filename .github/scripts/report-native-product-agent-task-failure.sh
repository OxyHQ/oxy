#!/bin/sh

set -eu

if [ "$#" -ne 2 ]; then
  echo '::error::native product-agent task failed; diagnostic arguments were invalid' >&2
  exit 0
fi

task_label="$1"
task_exit_code="$2"

case "$task_label" in
  preflight|dry-run-bootstrap|dry-run-rollback|apply|rollback) ;;
  *) task_label='unregistered' ;;
esac
case "$task_exit_code" in
  ''|*[!0-9]*) task_exit_code='unknown' ;;
esac

result_line=''
IFS= read -r result_line || true

if [ -z "$result_line" ]; then
  echo "::error::$task_label task exited $task_exit_code; result_present=no" >&2
  exit 0
fi

case "$result_line" in
  NATIVE_PRODUCT_AGENTS_RESULT=*)
    result_json=${result_line#NATIVE_PRODUCT_AGENTS_RESULT=}
    ;;
  *)
    echo "::error::$task_label task exited $task_exit_code; structured_result=invalid" >&2
    exit 0
    ;;
esac

safe_result=$(jq -cer '
  def valid_plan_sha:
    type == "string" and test("^[a-f0-9]{64}$");
  def valid_code:
    type == "string" and test("^[a-z][a-z0-9_]{0,63}$");
  def valid_generic_code:
    valid_code and . != "username_collision";
  def valid_drift_target:
    . == "oxy_organization" or
    . == "homiio_project_account" or
    . == "homiio_project_ancestry" or
    . == "homiio_bot_account" or
    . == "homiio_bot_ancestry" or
    . == "clarity_project_account" or
    . == "clarity_project_ancestry" or
    . == "clarity_bot_account" or
    . == "clarity_bot_ancestry" or
    . == "homiio_cost_center" or
    . == "clarity_cost_center" or
    . == "homiio_application" or
    . == "sindi_service_credential" or
    . == "clarity_application" or
    . == "clarity_public_credential" or
    . == "clarity_backend_application" or
    . == "clarity_backend_credential";
  def valid_drift_field:
    . == "id" or
    . == "username" or
    . == "nameDisplay" or
    . == "kind" or
    . == "type" or
    . == "parentAccountId" or
    . == "rootAccountId" or
    . == "accountStatus" or
    . == "privacyIsPrivateAccount" or
    . == "path" or
    . == "accountId" or
    . == "slug" or
    . == "label" or
    . == "status" or
    . == "isOfficial" or
    . == "isInternal" or
    . == "applicationId" or
    . == "name" or
    . == "publicKey" or
    . == "secretHash" or
    . == "secretHashPresent" or
    . == "environment" or
    . == "scopes" or
    . == "websiteUrl" or
    . == "capabilities" or
    . == "redirectUris" or
    . == "ownerAccountId" or
    . == "createdByUserId";
  def valid_account_id:
    type == "string" and (
      test("^[a-f0-9]{24}$") or
      test("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
    );
  def valid_nullable_account_id:
    . == null or valid_account_id;
  def valid_username_collision_holder:
    type == "object" and
    (keys | sort) == [
      "accountStatus",
      "id",
      "kind",
      "parentAccountId",
      "privacyIsPrivateAccount",
      "rootAccountId",
      "type"
    ] and
    (.id | valid_account_id) and
    (.kind == "personal" or .kind == "organization" or .kind == "project" or .kind == "bot" or .kind == "channel") and
    (.type == "local" or .type == "federated" or .type == "agent" or .type == "automated") and
    (.parentAccountId | valid_nullable_account_id) and
    (.rootAccountId | valid_nullable_account_id) and
    (.accountStatus == "active" or .accountStatus == "archived") and
    (.privacyIsPrivateAccount | type == "boolean");
  def valid_bound_application:
    . == null or (
      type == "object" and
      (keys | sort) == [
        "createdByUserId",
        "id",
        "isInternal",
        "isOfficial",
        "ownerAccountId",
        "status",
        "type"
      ] and
      (.id | valid_account_id) and
      (.ownerAccountId | valid_account_id) and
      (.type == "first_party" or .type == "third_party" or .type == "internal" or .type == "system") and
      (.status == "active" or .status == "suspended" or .status == "deleted" or .status == "pending_review") and
      (.isOfficial | type == "boolean") and
      (.isInternal | type == "boolean") and
      (.createdByUserId | valid_nullable_account_id)
    );
  def valid_plan:
    (
      (keys | sort) == ["direction","mode","planSha256"] or
      (keys | sort) == ["direction","mode","planSha256","serviceCredentialState"]
    ) and
    (.mode == "dry-run" or .mode == "apply") and
    (.direction == "bootstrap" or .direction == "rollback") and
    (.planSha256 | valid_plan_sha) and
    (
      (has("serviceCredentialState") | not) or
      (
        .serviceCredentialState | type == "object" and
        (keys | sort) == ["clarityBackendExists","homiioSindiExists"] and
        (.clarityBackendExists | type == "boolean") and
        (.homiioSindiExists | type == "boolean")
      )
    );
  if type != "object" then
    empty
  elif
    (keys | sort) == ["code","status"] and
    .status == "failed" and
    (.code | valid_generic_code)
  then
    {code}
  elif
    (keys | sort) == ["code","planSha256","status"] and
    .status == "failed" and
    (.code | valid_generic_code) and
    (.planSha256 | valid_plan_sha)
  then
    {code,planSha256}
  elif
    (keys | sort) == ["code","field","status","target"] and
    .status == "failed" and
    .code == "live_state_drift" and
    (.target | valid_drift_target) and
    (.field | valid_drift_field)
  then
    {code,target,field}
  elif
    (keys | sort) == ["boundApplication","code","expectedAccountId","holder","status"] and
    .status == "failed" and
    .code == "username_collision" and
    (.expectedAccountId | valid_account_id) and
    (.holder | valid_username_collision_holder) and
    (.boundApplication | valid_bound_application) and
    .holder.id != .expectedAccountId
  then
    {
      code,
      expectedAccountId,
      boundApplication,
      holder: {
        id: .holder.id,
        kind: .holder.kind,
        type: .holder.type,
        parentAccountId: .holder.parentAccountId,
        rootAccountId: .holder.rootAccountId,
        accountStatus: .holder.accountStatus,
        privacyIsPrivateAccount: .holder.privacyIsPrivateAccount
      }
    }
  elif valid_plan then
    {code:"task_exited_after_valid_plan",planSha256}
  else
    empty
  end
' <<EOF 2>/dev/null || true
$result_json
EOF
)

if [ -z "$safe_result" ]; then
  echo "::error::$task_label task exited $task_exit_code; structured_result=invalid" >&2
  exit 0
fi

echo "::error::$task_label task exited $task_exit_code; structured_result=$safe_result" >&2
