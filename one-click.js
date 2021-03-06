(function(glob) {
  
  function relativizeImpl(requiringDirRelRoot, toRel) {
    if(toRel.length === 0) {
      throw ["Cannot resolve ", requiringDirRelRoot.join('/'), toRel.join('/')];
    } else if(toRel[0][0] == '.' && toRel[0][1] === '.' && toRel[0].length === 2) {
      if (requiringDirRelRoot.length == 0) {
        throw ["Cannot resolve ", requiringDirRelRoot.join('/'), toRel.join('/')];
      }
      return relativizeImpl(
        requiringDirRelRoot.slice(0, requiringDirRelRoot.length - 1),
        toRel.slice(1).concat(['.']),
      );
    } else if(toRel[0][0] == '.' && toRel[0].length === 1) {
      // We know toRel is at least one. Is it two?
      if(toRel.length === 2) {
        var fileName = toRel[1];
        if(fileName.indexOf(".js") === -1 || fileName.indexOf(".js") !== fileName.length -3) {
          return [requiringDirRelRoot.concat(toRel[1]), 'index.js'];
        } else {
          return [requiringDirRelRoot, toRel[1]];
        }
      } else {
        return relativizeImpl(
          requiringDirRelRoot.concat(toRel[1]),
          ['.'].concat(toRel.slice(2))
        );
      }
    } else {
      return relativizeImpl(
        ['node_modules'],
        ['.'].concat(toRel)
      );
    };
  }
  var OneClick = {
    modulesFromRoot: {},
    resolve: function(requiringFileRelRoot, toRelativePath) {
      var fromRelativeToRootSplit = requiringFileRelRoot.split('/');
      var toRelativePathSplit = toRelativePath.split('/');
      var segments = relativizeImpl(
        // Remove the depending file, to leave only the dir
        fromRelativeToRootSplit.slice(0, fromRelativeToRootSplit.length - 1),
        toRelativePathSplit
      );
      return (segments[0]).concat(segments[1]).join('/')
    }
  };
  var canAndShouldBeLoadedNow = function(moduleData) {
    var allLoading = true;
    if(moduleData.status !== 'loading') {
      for(var dep in moduleData.dependencies) {
        if(OneClick.modulesFromRoot[dep].status !== 'loading') {
          return null;
        }
      }
      return moduleData;
    } else {
      return null;
    }
  };
  var notLoaded = function(moduleData) {
    if(moduleData.status !== 'loading') {
      return moduleData;
    } else {
      return null;
    }
  };
  function firstNonNull(predicate) {
    var allHave = true;
    for(var aRelModPath in OneClick.modulesFromRoot) {
      var moduleData = OneClick.modulesFromRoot[aRelModPath];
      var result = predicate(moduleData);
      if(result !== null) {
        return result;
      }
    }
    return null;
  }
  window.require = function(path) {
    var resolved = OneClick.resolve("main.html", path);
    var moduleData = OneClick.modulesFromRoot[resolved];
    if(!moduleData) {
      throw "Module has not been initialized by anyone " + path;
    }
    if(moduleData.status !== 'loading') {
      throw "Module has not yet been loaded " + path;
    }
    return moduleData.moduleExports;
  };
  function loadModuleForModuleData(moduleData) {
    moduleData.status = 'loading';
    var iframe = document.createElement('iframe');
    iframe.style="display:none !important"
    document.body.appendChild(iframe);
    var doc =iframe.contentWindow.document;
    iframe.onload=function(){document.body.removeChild(iframe)};
    var isolatedScript = `
        <html><head><title></title></head><body>
        <script>
          var origExports = {};
          window.module = {
            exports: origExports
          };
          window.exports = module.exports;
          require = function(reqPath) {
            var resolved = parent.OneClick.resolve("${moduleData.relPath}", reqPath);
            return parent.window.OneClick.modulesFromRoot[resolved].moduleExports;
          };
        </script>
        <script src="${moduleData.relPath}"> </script></body></html>
        <script>
          parent.window.OneClick.modulesFromRoot["${moduleData.relPath}"].moduleExports = window.module.exports;
        </script>
        </body></html>
    `;
    doc.open();
    doc.write(isolatedScript)
    doc.close();
  }
  var handleScrapeMesage = function(moduleAt, makesRequireCalls) {
    var dependencies = {};
    OneClick.modulesFromRoot[moduleAt].status = 'scraped';
    for(var requireCall in makesRequireCalls) {
      var rootRelRequireCall = OneClick.resolve(moduleAt, requireCall);
      dependencies[rootRelRequireCall] = true;
      requireScrapeRound(moduleAt, requireCall);
    }
    OneClick.modulesFromRoot[moduleAt].dependencies = dependencies;
    function allHaveStatus(status) {
      var allHave = true;
      for(var aRelModPath in OneClick.modulesFromRoot) {
        var moduleData = OneClick.modulesFromRoot[aRelModPath];
        for(var dependency in moduleData.dependencies) {
          if(!OneClick.modulesFromRoot[dependency] ||
            OneClick.modulesFromRoot[dependency].status !== status) {
            allHave = false;
          };
        }
      }
      return allHave;
    }
    var allScraped = allHaveStatus('scraped');
    if(allScraped) {
      var canBeLoaded;
      var count = 0;
      while(count++ < 100 && ((canBeLoaded = firstNonNull(canAndShouldBeLoadedNow))!= null)) {
        loadModuleForModuleData(canBeLoaded);
      }
      var wasNotLoaded = firstNonNull(notLoaded);
      if(wasNotLoaded !== null) {
        // TODO: Support circular dependencies.
        console.error(
          "Circular dependency or unsatisfiable module " + wasNotLoaded.relPath,
          wasNotLoaded
        );
      }
    }
  };

  var handleBadRequireMessage = function(requestedBy, requireCall) {
    console.error("Module " + requestedBy + " required('" + requireCall + "') which does not exist.");
  };
  
  // We get messages back about which modules depend on which.
  window.onmessage = function(msg) {
    if(msg.data.type === 'scrapeMessage') {
      handleScrapeMesage(msg.data.moduleAt, msg.data.makesRequireCalls);
    } else if(msg.data.type === 'badRequire') {
      handleBadRequireMessage(msg.data.requestedBy, msg.data.requireCall);
    } 
  };
  function requireScrapeRound(fromModulePath, reqPath) {
    if(fromModulePath.charAt(0) === '.' && fromModulePath[1] === '/') {
      fromModulePath = fromModulePath.substr(2);
    }
    var pathSegments = fromModulePath.split('/');
    var relativized = OneClick.resolve(fromModulePath, reqPath);
    return scrapeModuleIdempotent(relativized, fromModulePath);
  }
  function requirePrepareMain(reqPath) {
    return requireScrapeRound('./main.html', reqPath);
  }
  function scrapeModuleIdempotent(relPathFromRoot, requestedBy) {
    if(OneClick.modulesFromRoot[relPathFromRoot]) {
      if(OneClick.modulesFromRoot[relPathFromRoot].status === 'scraping' ||
        OneClick.modulesFromRoot[relPathFromRoot].status === 'scraped') {
        return;
      }
    }
    var origExports = {};
    window.module = {
      exports: origExports
    };
    window.exports = module.exports;
    var moduleData = {
      status: 'scraping',
      relPath: relPathFromRoot,
      moduleExports: module.exports,
      dependencies: null
    };
    OneClick.modulesFromRoot[relPathFromRoot] = moduleData;
    // Scrape the dependencies by dry running them.
    
    var iframe = document.createElement('iframe');
    iframe.style="display:none !important"
    document.body.appendChild(iframe);
    iframe.onload=function(){document.body.removeChild(iframe)};
    var scrapingScript =
    `<html><head><title></title></head><body>
      <script>
        // Suppress any IO we can - we just want to scrape the deps.
        var foooo = "bar";
        window.recordedDependencies = {
        };
        window.recordedDependencies = {
        };
        console = {log: function(args) { }};
        console.error = window.console.log;
        console.warn = window.console.log;
        console.table = window.console.log;
        window.onerror = function(msg, url, lineNo, columnNo, error){
          // In iframe error - mask all issues.
          debugger;
          return true;
        };
        exports = {};
        module = {
          exports: exports
        };
        require = function(modPath) {
          window.recordedDependencies[modPath] = true;
          // TODO: make this a proxy object.
          return { };
        };
        function onBadDep() {
          parent.postMessage(
            {type: 'badRequire', requestedBy: "${requestedBy}", requireCall: "${relPathFromRoot}"},
            '*'
          );
        }
      </script>
      <script onerror="onBadDep()"src="${relPathFromRoot}"> </script></body></html>
      <script>
        parent.postMessage(
          {type:'scrapeMessage', moduleAt: "${relPathFromRoot}", makesRequireCalls: window.recordedDependencies},
          '*'
        );
        // Just in case you try to require() in a Chrome console that is still
        // debugging this iframe.
        require = parent.require;
      </script>
    `;
    var doc =iframe.contentWindow.document;
    doc.open();
    doc.write(scrapingScript)
    doc.close();
  }
  var main = document.querySelector("script[data-main]");
  var main = main.dataset.main;
  
  // This isn't really commonJS compliant, but we'll relax it just for the data-main attribute.
  if(main) {
    if(main.indexOf(".js") !== -1 || main.indexOf(".js") === main.length - 3) {
      if(main.indexOf('/') === -1 && main[0] !== '.') {
        main = './' + main;
      }
    }
    requirePrepareMain(main);
  }
  glob.OneClick = OneClick;
})(window);
