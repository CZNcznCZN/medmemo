@echo off
cd /d "%~dp0"

REM 全程写日志，每步都 >>，便于诊断闪退
> _medmemo_boot.log echo === MedMemo start %date% %time% ===
>> _medmemo_boot.log echo CWD: %CD%

REM ---- 检测单实例锁端口 17530 是否被占 ----
REM 用 netstat 输出到临时文件再 findstr，避免管道在 for /f 内的兼容性问题
netstat -ano > _netstat_tmp.txt 2>nul
>> _medmemo_boot.log echo netstat 采集完成

set "LOCKED_PID="
for /f "tokens=5" %%P in ('findstr "127.0.0.1:17530" _netstat_tmp.txt') do (
    set "LOCKED_PID=%%P"
)
del _netstat_tmp.txt >nul 2>&1

>> _medmemo_boot.log echo LOCKED_PID=[%LOCKED_PID%]

if defined LOCKED_PID (
    >> _medmemo_boot.log echo [!] already running PID %LOCKED_PID%
    echo.
    echo [!] A MedMemo instance is already running (PID: %LOCKED_PID%).
    echo     Opening the existing instance in the browser...
    start "" http://localhost:8000
    echo.
    echo     If it misbehaves, kill it and re-run:
    echo         taskkill /F /PID %LOCKED_PID%
    echo.
    pause
    exit /b 0
)

REM ---- 端口空闲，正常启动 ----
>> _medmemo_boot.log echo port free, starting server
echo Starting server...
start "" http://localhost:8000
python server.py
set "EXITCODE=%ERRORLEVEL%"
>> _medmemo_boot.log echo python exited code %EXITCODE%

if %EXITCODE%==0 (
    echo [i] Server exited (code 0).
) else (
    echo [!] Server exited abnormally, code: %EXITCODE%
)
echo.
echo (see _medmemo_boot.log for details)
echo.
pause
