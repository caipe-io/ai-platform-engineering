@echo off
setlocal

REM Run HotpotQA evaluation using the repository defaults.
REM Additional CLI arguments can be passed to override the defaults.

set "REPO_ROOT=%~dp0.."
set "PYTHON_BIN=python"
if not "%PYTHON%"=="" set "PYTHON_BIN=%PYTHON%"

"%PYTHON_BIN%" "%REPO_ROOT%\src\deepeval_eval\engine\deepeval_evaluator.py" eval ^
  --dataset-name hotpotqa ^
  --max-items 10 ^
  --top-k 5 ^
  --max-context-chars 12000 ^
  %*

exit /b %ERRORLEVEL%
