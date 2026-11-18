@echo off
setlocal
set "guest=%SystemRoot%\Temp\PLF12"
if not exist "%guest%\" mkdir "%guest%" || exit /b 1
"%SystemRoot%\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /target:winexe /r:System.Core.dll /out:"%guest%\F12Media.exe" "%SystemRoot%\System32\F12Media.cs" >"%guest%\startup.log" 2>&1
if errorlevel 1 exit /b 1
start "" "%guest%\F12Media.exe" --mount
