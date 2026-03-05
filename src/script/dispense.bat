@echo off
title PhIS Auto Dispenser Launcher
echo Checking for dependencies...

if not exist "node.exe" (
    echo ? Error: node.exe not found in this folder!
    pause
    exit
)

if not exist "config.txt" (
    echo ? Error: config.txt is missing!
    pause
    exit
)

echo 🚀 Starting PhIS Auto Dispenser...
echo.

:: Use the local node.exe to run the script
start "" /B ".\node.exe" dispense.js
start "" /B ".\node.exe" watcher.js

echo.
echo ?? Script has finished or crashed.
pause