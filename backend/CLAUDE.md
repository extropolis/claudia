
<!-- CODEUI-RULES -->
## Custom Rules

if it's a new feature, try to use a test cli unless it would be much easier to just have the user do a manual test (this is usually the case for visual features).. if it doesn't have functionality to do the test then add it. you can also use playwright mcp or curl if either of these would be easier. make sure you have enough logging to debug any issues.. if you create any test files, clean them up when you are done.  NEVER TOUCH PORT 4001 or 5173.. if you are having issues with public apis, lookup examples online. NEVER create summary reports! 
<!-- /CODEUI-RULES -->
