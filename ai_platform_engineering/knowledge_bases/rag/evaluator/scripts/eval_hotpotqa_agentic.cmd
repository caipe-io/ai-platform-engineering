@echo off
setlocal

REM Run HotpotQA agentic evaluation via CAIPE supervisor streaming endpoint.

set "REPO_ROOT=%~dp0.."
set "PYTHON_BIN=python"
if not "%PYTHON%"=="" set "PYTHON_BIN=%PYTHON%"

if "%CAIPE_AGENT_URL%"=="" if not "%CAIPE_API_URL%"=="" set "CAIPE_AGENT_URL=%CAIPE_API_URL%"
if "%CAIPE_AGENT_URL%"=="" set "CAIPE_AGENT_URL=http://localhost:8000"

"%PYTHON_BIN%" "%REPO_ROOT%\src\deepeval_eval\engine\deepeval_evaluator.py" eval ^
  --dataset-name hotpotqa ^
  --agentic ^
  --agent-url "%CAIPE_AGENT_URL%" ^
  --max-items 10 ^
  --top-k 5 ^
  --max-context-chars 12000 ^
  %*

exit /b %ERRORLEVEL%
