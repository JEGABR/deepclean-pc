@echo off
title DeepClean PC Launcher
cd /d "%~dp0"
if not exist "node_modules\electron" (
    echo Instalando dependencias do DeepClean PC...
    call npm install
)
echo Iniciando DeepClean PC...
start "" npm start
