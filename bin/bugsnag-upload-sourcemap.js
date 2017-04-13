// Uploads a source map and app bundle to Bugsnag to improve stacktraces
// during debugging

const fs = require('fs'),
      path = require('path'),
      request = require('request'),
      UPLOAD_SERVER = "https://upload.bugsnag.com";

var argv = process.argv.slice(2),
    packageJSON;

function printUsage() {
  console.log(`Usage: bugsnag-upload-sourcemap --minified-file FILE --source-map FILE
  [--api-key KEY] [--app-version VERSION] [--code-bundle-id ID]
  [--minified-url URL] [--project-root DIR] [--upload-sources]

  -h, --help            Print this message
  --api-key KEY         Set the API key used during upload
  --app-version VERSION Sets the app version. By default loaded from package.json
  --code-bundle-id ID   The CodePush label or identifier set as codeBundleId in
                        the current release. Overrides app version.
  --minified-file FILE  The app bundle file
  --minified-url URL    The minified URL of the app. Defaults to main.jsbundle
  --project-root DIR    The root path to remove from absolute file paths. Defaults
                        to current directory
  --source-map FILE     The source map file
  --upload-sources      Upload source files referenced by the source map`);
}

function exitWithUsage(errorMessage) {
  console.log(errorMessage);
  printUsage();
  process.exit(1);
}

function exitWithError(errorMessage) {
  console.log(errorMessage);
  process.exit(1);
}

// Remove a key in argv and return true if present
// @return boolean
function shiftArgBool(name) {
  const index = argv.indexOf(name);
  if (index != -1) {
    argv.splice(index, 1);
    return true;
  }
  return false;
}

// Remove a key/value pair in argv and return the value if available
// Exits early if the key is specified without a value or if the key is
// required but not set
// @return String|null
function shiftArgString(name, required) {
  const index = argv.indexOf(name);
  if (index != -1) {
    if (argv.length > index + 1 && argv[index + 1].indexOf("-") != 0) {
      return argv.splice(index, 2)[1];
    } else {
      exitWithUsage(name + " provided without a value");
    }
  }

  if (required)
    exitWithUsage(name + " is required but not set");

  return null;
}

// Remove a key/value pair in argv and return the value if available, converting
// the path to be relative to the adjusted current working directory if not
// absolute
// @return String|null
function shiftArgPath(name, required) {
  const value = shiftArgString(name, required);
  if (value && !path.isAbsolute(value)) {
    return path.join(currentWorkingDirectory(), value);
  }
  return value;
}

// Fetch a value from package.json within the project root. If unavailable
// print an error message indicating property or flag must be set.
// Exits early if the file could not be parsed or the property was not available
// @return Object|null
function packageProperty(projectRoot, name, optionFlag) {
  if (!packageJSON) {
    const packagePath = path.join(projectRoot, "package.json");
    if (fs.existsSync(packagePath)) {
      try {
        packageJSON = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
      } catch (err) {
        exitWithError("Unable to load the project's package.json: " + err);
      }
    } else {
      exitWithUsage("Unable to find the project's package json. Please set --project-root or run from the project directory");
    }
  }
  const value = packageJSON[name];
  if (!value)
    exitWithUsage("Unable to fetch " + name + " from package.json. Update package.json or specify with " + optionFlag);

  return value;
}

// Load source map contents into memory as JSON
// Exits early if the file could not be parsed
// @return Object|null
function loadSourceMapContent(sourceMap) {
  try {
    return JSON.parse(fs.readFileSync(sourceMap, 'utf8'));
  } catch (e) {
    exitWithError("Could not parse source map: " + e);
  }
}

// Parse a source map, returning an array of all source files
// Stores source map contents in a shared cache
// @return Array
function parseSources(sourceMap) {
  var contents = loadSourceMapContent(sourceMap),
      files = [];
  if (contents.sources)
    files = files.concat(contents.sources);

  if (contents.sections) {
    contents.sections.forEach(function(section) {
      if (section.map && section.map.sources)
        files = files.concat(section.map.sources);
    })
  }
  return files;
}

// Make a version of filePath relative to rootDir unless filePath is already
// a relative path
function makeRelativePath(rootDir, filePath) {
  if (typeof filePath == 'string' && path.isAbsolute(filePath))
    return path.relative(rootDir, filePath);
  return filePath;
}

// Parse a source map, trimming project root from map sources
// Stores source map contents in a shared cache
// @return Object cache object
function trimProjectRoot(projectRoot, sourceMap) {
  var contents = loadSourceMapContent(sourceMap),
      absoluteRoot = path.isAbsolute(projectRoot) ? projectRoot : path.join(currentWorkingDirectory(), projectRoot);

  if (contents.sources)
    contents.sources = contents.sources.map(makeRelativePath);

  if (contents.sections) {
    for (var i = 0; i < contents.sections.length; i++) {
      var section = contents.sections[i];
      if (section.map && section.map.sources)
        section.map.sources = section.map.sources.map(makeRelativePath);
    }
  }
  return contents;
}

// The directory where the script is being executed. If within node modules,
// assume the script is being run via `npm run` from a parent project and change
// the directory
// @return String
function currentWorkingDirectory() {
  const currentDir = process.cwd();
  if (currentDir.indexOf("node_modules") != -1) {
    return path.join(currentDir, "..", "..");
  }
  return currentDir;
}

// main

if (shiftArgBool("-h") || shiftArgBool("--help")) {
  printUsage();
  process.exit(0);
}

const projectRoot = shiftArgPath("--project-root") || currentWorkingDirectory(),
      apiKey = shiftArgString("--api-key") || packageProperty(projectRoot, "bugsnagApiKey", "--api-key"),
      codeBundleId = shiftArgString("--code-bundle-id"),
      appVersion = !codeBundleId ? shiftArgString("--app-version") || packageProperty(projectRoot, "version", "--app-version") : null,
      minifiedFile = shiftArgPath("--minified-file", true),
      minifiedUrl = shiftArgString("--minified-url") || 'main.jsbundle',
      sourceMap = shiftArgPath("--source-map", true),
      uploadSources = shiftArgBool("--upload-sources");

if (argv.length > 0)
  exitWithUsage("Invalid options specified: " + argv.join(" "));

if (!fs.existsSync(sourceMap))
  exitWithError("Source map file not found: " + sourceMap);

if (!fs.existsSync(minifiedFile))
  exitWithError("Minified bundle file not found: " + minifiedFile);


var formData = {
  overwrite: true,
  apiKey: apiKey,
  minifiedUrl: minifiedUrl,
  minifiedFile: fs.createReadStream(minifiedFile),
};

if (codeBundleId)
  formData.codeBundleId = codeBundleId;
else
  formData.appVersion = appVersion;

if (uploadSources) {
  parseSources(sourceMap).forEach(function(src) {
    if (fs.existsSync(src))
      formData[makeRelativePath(projectRoot, src)] = fs.createReadStream(src);
  });
}

formData.sourceMap = JSON.stringify(trimProjectRoot(projectRoot, sourceMap));

request.post({url: UPLOAD_SERVER, formData: formData}, function(err) {
  if (err) {
    exitWithError("Failed to upload source map data: " + err);
  }
});
