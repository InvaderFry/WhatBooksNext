@echo off
rem Opens the DEMO library: invented books, so you can try whatBooksNext without your own.
rem It never touches your real library or data, and it starts fresh every time.
rem It uses its own port (4819), so it can run alongside the real app.
setlocal
set DEMO=1
set PORT=4819
call "%~dp0start-whatBooksNext.bat" %*
endlocal
