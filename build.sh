#!/bin/sh
# Wraps app.html (the artifact source, which has no <html>/<head>/<body>) into the standalone website, index.html.
# If site-ai-url.txt holds the URL of the Bridge AI server (worker/), the page uses it for live AI with no key.
cd "$(dirname "$0")" || exit 1
AI_URL=""
[ -f site-ai-url.txt ] && AI_URL=$(tr -d ' \r\n' < site-ai-url.txt)
DESC="Bridge finds the background ideas and academic words an intro STEM text assumes, checks which ones a student really has, and teaches only the missing pieces."
{
  printf '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
  printf '<meta name="description" content="%s">\n' "$DESC"
  printf '<meta property="og:title" content="Bridge: find what your reading assumes">\n<meta property="og:description" content="%s">\n<meta property="og:type" content="website">\n' "$DESC"
  printf '<meta name="theme-color" content="#cfe3f8" media="(prefers-color-scheme: light)">\n<meta name="theme-color" content="#0d1a2f" media="(prefers-color-scheme: dark)">\n'
  printf '%s\n' "<link rel=\"icon\" href=\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 34 22' fill='none' stroke='%231257d6' stroke-width='2.6' stroke-linecap='round'%3E%3Cpath d='M2 19h30M6 19v-8M28 19v-8M17 19v-9M3 11c7-10 21-10 28 0'/%3E%3C/svg%3E\">"
  [ -n "$AI_URL" ] && printf '<meta name="bridge-ai" content="%s">\n' "$AI_URL"
  printf '<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}[hidden]{display:none!important}img{max-width:100%%}</style>\n</head>\n<body>\n'
  cat app.html
  printf '\n</body>\n</html>\n'
} > index.html
echo "Built $(pwd)/index.html${AI_URL:+ (live AI: $AI_URL)}"
