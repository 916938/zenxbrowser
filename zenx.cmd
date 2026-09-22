@echo off
setlocal
rem zenx launcher - runs src/cli.ts with Node (Node >= 22.18 runs TypeScript directly).
set "ZENX_DIR=%~dp0"
set "NODE_EXE="

if defined ZENX_NODE if exist "%ZENX_NODE%" set "NODE_EXE=%ZENX_NODE%"
if not defined NODE_EXE (
  for /f "delims=" %%N in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%N"
)
if not defined NODE_EXE (
  for %%D in ("%ProgramFiles%\nodejs" "%LOCALAPPDATA%\Programs\nodejs" "%USERPROFILE%\AppData\Roaming\nvm" "D:\packages\nvm\nodejs" "D:\packages\nvm\v24.16.0" "D:\packages\nvm\v22.22.3" "D:\programs\Scoop\apps\nodejs\current") do (
    if exist "%%~D\node.exe" set "NODE_EXE=%%~D\node.exe"
  )
)
if not defined NODE_EXE (
  echo zenx: cannot find node.exe. Install Node.js ^>= 22.18 or set ZENX_NODE to its full path. 1>&2
  exit /b 127
)

"%NODE_EXE%" "%ZENX_DIR%src\cli.ts" %*
exit /b %ERRORLEVEL%
