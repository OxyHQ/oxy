#!/usr/bin/env bash

# Store one SecureString without ever putting its value in a child process's
# argv. AWS CLI reads the scalar value itself from stdin via its supported
# `file://` parameter-file form. Do not combine `--cli-input-json` with the
# stdin device: AWS CLI 2.35 rejects that stream before making the request.

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

aws_arguments=(
  ssm put-parameter
  --name "$parameter_name"
  --type SecureString
  --value file:///dev/stdin
)
if [ "$overwrite" = true ]; then
  aws_arguments+=(--overwrite)
fi
if [ -n "$description" ]; then
  aws_arguments+=(--description "$description")
fi

# Read only one character to reject an empty stream, then forward that character
# plus the untouched remainder. The complete value is never stored in a shell
# variable, argument, environment variable or intermediate file.
if ! IFS= read -r -N 1 first_character; then
  echo "secure parameter value is empty" >&2
  exit 64
fi
{
  printf '%s' "$first_character"
  cat
} | aws "${aws_arguments[@]}" >/dev/null
