#!/bin/sh
# repro.sh <tag> : long foreground command, then an attachment message, then a steer.
L=$(dirname "$0"); T=$1
$L/add.sh "{\"text\":\"Reply STARTING-$T, then run this shell command in the foreground, not in the background: python3 -c 'import time;time.sleep(150)'  and when it finishes reply LONGDONE-$T.\"}"
sleep 14
$L/add.sh "{\"text\":\"Here is the report file for later.\",\"files\":[{\"name\":\"report-$T.txt\"}]}"
sleep ${2:-5}
$L/add.sh "{\"text\":\"/steer Change of plan: drop the sleep, do not run it again. What is 17 times 3? Reply STEERED-$T and the number.\",\"messageType\":\"slash_command\",\"commandName\":\"steer\",\"commandArgs\":\"Change of plan: drop the sleep, do not run it again. What is 17 times 3? Reply STEERED-$T and the number.\"}"
