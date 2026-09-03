#!/usr/bin/env bash

# Store one SecureString without ever putting its value in a child process's
# argv. The value is accepted only on stdin and AWS CLI reads its complete input
# document from stdin as well.

set -euo pipefail

if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
  echo "usage: put-secure-parameter.sh <parameter-name> <create|overwrite> [description]" >&2
  exit 64
fi

parameter_name="$1"
write_mode="$2"
description="${3-}"

if [[ ! "$parameter_name" =~ ^/oxy/[A-Za-z0-9_./-]+$ ]]; then
  echo "parameter name must be under /oxy/" >&2
  exit 64
fi

case "$write_mode" in
  create) overwrite=false ;;
  overwrite) overwrite=true ;;
  *)
    echo "write mode must be create or overwrite" >&2
    exit 64
    ;;
esac

jq -Rsc \
  --arg name "$parameter_name" \
  --arg description "$description" \
  --argjson overwrite "$overwrite" '
    if length == 0 then error("secure parameter value is empty") else
      {
        Name: $name,
        Type: "SecureString",
        Value: .,
        Overwrite: $overwrite
      } + (if $description == "" then {} else {Description: $description} end)
    end
  ' | aws ssm put-parameter --cli-input-json file:///dev/stdin >/dev/null
