#!/bin/sh
# add.sh '<json body>'
curl -s -X POST http://127.0.0.1:47813/__add -d "$1"; echo
