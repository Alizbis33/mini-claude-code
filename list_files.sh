#!/usr/bin/env bash
# 列出当前文件夹下的文件
set -euo pipefail

# 只列文件（不含子目录），按名称排序
find . -maxdepth 1 -type f -printf '%f\n' | sort

