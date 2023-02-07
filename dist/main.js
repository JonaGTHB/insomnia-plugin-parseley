var __defProp = Object.defineProperty;
var __markAsModule = (target) => __defProp(target, "__esModule", { value: true });
var __export = (target, all) => {
  __markAsModule(target);
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// master.ts
__export(exports, {
  workspaceActions: () => workspaceActions
});
async function parseFileTextIntoLines(fileContent) {
  return fileContent.split(/\r?\n/).filter((line) => {
    line = line.trim();
    return !(line.startsWith("Accept") || line.startsWith("Cache-Control") || line.startsWith("Content-Type") || line.startsWith("x-") || line === "");
  });
}
async function isRequestStart(line) {
  const requestMethods = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"];
  for (const requestMethod of requestMethods) {
    if (line.startsWith(requestMethod)) {
      return requestMethod;
    }
  }
  return null;
}
async function partitionFileLinesByRequestAndExtractBasicData(lines) {
  let isParsingRequest = false;
  let requestLines = [];
  const requests = [];
  let requestMethod = null;
  let requestName = null;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    const isRequestStartLine = await isRequestStart(line);
    if (isRequestStartLine !== null) {
      line = line.replace(isRequestStartLine, "").trim();
      if (isParsingRequest) {
        requestLines = requestLines.filter((line2) => !line2.trim().startsWith("###"));
        requests.push({ requestMethod, requestName, requestLines });
        requestLines = [];
      }
      requestName = await extractNameFromComment(lines, i);
      isParsingRequest = true;
      requestMethod = isRequestStartLine;
    }
    if (isParsingRequest) {
      requestLines.push(line);
    }
    if (i === lines.length - 1) {
      requestLines = requestLines.filter((line2) => !line2.trim().startsWith("###"));
      requests.push({ requestMethod, requestName, requestLines });
    }
  }
  return requests;
}
async function extractNameFromComment(lines, index) {
  if (index === 0) {
    return null;
  }
  const commentLine = lines[index - 1];
  if (commentLine) {
    const parsedName = commentLine.trim().replace("###", "").trim();
    if (parsedName !== "") {
      return parsedName;
    }
  }
  return null;
}
var services = new Map();
var AuthorizationType;
(function(AuthorizationType2) {
  AuthorizationType2["BASIC"] = "Basic";
  AuthorizationType2["BASIC_USERNAME_PASSWORD"] = "BasicUP";
  AuthorizationType2["BEARER"] = "Bearer";
})(AuthorizationType || (AuthorizationType = {}));
async function extractAuthorizationFromLine(line) {
  const authWithType = line.replace("Authorization:", "").trim();
  if (authWithType.startsWith(AuthorizationType.BASIC)) {
    let auth = authWithType.replace(AuthorizationType.BASIC, "").trim();
    if (auth.split(" ").length === 2) {
      const [username, password] = auth.split(" ");
      return {
        type: AuthorizationType.BASIC_USERNAME_PASSWORD,
        auth: {
          username,
          password
        }
      };
    } else {
      return {
        type: AuthorizationType.BASIC,
        auth
      };
    }
  } else if (authWithType.startsWith(AuthorizationType.BEARER)) {
    let auth = authWithType.replace(AuthorizationType.BEARER, "").trim();
    return {
      type: AuthorizationType.BEARER,
      auth
    };
  }
}
function insomniaIdGenerator() {
  let index = 0;
  return function generateInsomniaId2() {
    index += 1;
    return `__INSOMNIA_${index}__`;
  };
}
function getCurrentWorkspace(models) {
  return models.workspace;
}
var generateInsomniaId = insomniaIdGenerator();
async function extractRequestsFromLinesByRequest(linesByRequest, parentId, fileName) {
  let url = null;
  let auth = null;
  let body = "";
  const requests = [];
  for (const requestsAsLines of linesByRequest) {
    body = "";
    for (let i = 0; i < requestsAsLines.requestLines.length; i++) {
      let line = requestsAsLines.requestLines[i];
      line = await correctTemplateMarker(line);
      if (i == 0) {
        url = line;
      } else {
        if (line.startsWith("Authorization:")) {
          auth = await extractAuthorizationFromLine(await correctTemplateMarker(line));
        } else {
          body += line;
        }
      }
    }
    let request = {
      _id: generateInsomniaId(),
      _type: "request",
      body: {
        mimeType: "application/json",
        text: JSON.parse(JSON.stringify(body))
      },
      name: fileName,
      description: requestsAsLines.requestName ?? "",
      method: requestsAsLines.requestMethod,
      url,
      parentId
    };
    if (auth !== null) {
      if (auth.type === AuthorizationType.BASIC) {
        request.authentication = auth.auth;
      } else {
        if (auth.type === AuthorizationType.BASIC_USERNAME_PASSWORD) {
          request.authentication = auth.auth;
        } else {
          request.authentication = {
            type: "bearer",
            token: auth.auth
          };
        }
      }
    }
    requests.push(request);
  }
  return requests;
}
async function correctTemplateMarker(line) {
  const matches = line.match(/{{ *[a-zA-Z]* *}}/g);
  if (matches === null) {
    return line;
  }
  matches.forEach((match) => {
    match = match.trim();
    const text = match.replace("{{", "").replace("}}", "").trim();
    line = line.replace(match, `{{_.${text}}}`);
  });
  return line;
}
async function handleServiceImport(files, models, context, service) {
  const workspace = getCurrentWorkspace(models);
  let serviceGroup = {
    parentId: workspace._id,
    name: service,
    _type: "request_group",
    _id: generateInsomniaId()
  };
  const allChildren = [serviceGroup];
  for (const file of files) {
    const fileName = file.name.replace(".http", "");
    let requestGroup = {
      parentId: serviceGroup._id,
      name: fileName,
      _type: "request_group",
      _id: generateInsomniaId()
    };
    const fileHandle = await file.handle.getFile();
    const fileLines = await parseFileTextIntoLines(await fileHandle.text());
    const requests = await partitionFileLinesByRequestAndExtractBasicData(fileLines);
    const insomniaRequests = await extractRequestsFromLinesByRequest(requests, requestGroup._id, fileName);
    let all = [requestGroup, ...insomniaRequests];
    allChildren.push(...all);
  }
  let resources = [...allChildren, workspace];
  let insomniaExportLike = {
    resources,
    __export_format: 4,
    _type: "export"
  };
  await context.data.import.raw(JSON.stringify(insomniaExportLike), { workspaceId: workspace._id });
}
async function importRequestFromFile(file, models, context, service) {
  const fileContent = await file.text();
  const fileLines = await parseFileTextIntoLines(fileContent);
  const requests = await partitionFileLinesByRequestAndExtractBasicData(fileLines);
  const workspace = getCurrentWorkspace(models);
  let requestGroup = {
    parentId: workspace._id,
    name: file.name.replace(".http", ""),
    _type: "request_group",
    _id: generateInsomniaId()
  };
  const insomniaRequests = await extractRequestsFromLinesByRequest(requests, requestGroup._id, file.name);
  let all = [requestGroup, ...insomniaRequests];
  let resources = [...all, workspace];
  let insomniaExportLike = {
    resources,
    __export_format: 4,
    _type: "export"
  };
  await context.data.import.raw(JSON.stringify(insomniaExportLike), { workspaceId: workspace._id });
}
var importFile = async function importFile2(context, models) {
  const [fileHandle] = await window.showOpenFilePicker();
  const file = await fileHandle.getFile();
  if (file) {
    await importRequestFromFile(file, models, context);
  }
  await context.app.alert("Import finished successfully");
};
async function listAllFilesAndDirs(dirHandle) {
  const files = [];
  for await (let [name, handle] of dirHandle) {
    const { kind } = handle;
    if (handle.kind === "directory") {
      files.push(...await listAllFilesAndDirs(handle));
    } else {
      if (name.endsWith(".http")) {
        files.push({ name, handle, kind });
      }
    }
  }
  return files;
}
async function listAllFilesAndAssociateToService(dirHandle, service = "", isFirstSubDir = true) {
  const files = [];
  for await (let [name, handle] of dirHandle) {
    const { kind } = handle;
    if (handle.kind === "directory") {
      if (isFirstSubDir) {
        files.push(...await listAllFilesAndAssociateToService(handle, name, false));
      } else {
        files.push(...await listAllFilesAndAssociateToService(handle, service, isFirstSubDir));
      }
    } else {
      if (name.endsWith(".http")) {
        if (!services.has(service)) {
          services.set(service, null);
        }
        files.push({ name, handle, kind, service });
      }
    }
  }
  return files;
}
var importFilesRecursively = async function importFile3(context, models) {
  const directoryHandle = await window.showDirectoryPicker();
  const files = await listAllFilesAndDirs(directoryHandle);
  for (const file of files) {
    await importRequestFromFile(await file.handle.getFile(), models, context);
  }
  await context.app.alert("Import finished successfully");
};
var importFilesRecursivelyAsServices = async function importFile4(context, models) {
  const directoryHandle = await window.showDirectoryPicker();
  let files = await listAllFilesAndAssociateToService(directoryHandle);
  services.forEach(async (value, key) => {
    const filesForService = files.filter((file) => file.service === key);
    await handleServiceImport(filesForService, models, context, key);
  });
  await context.app.alert("Import finished successfully");
};
var importFiles = async function importFile5(context, models) {
  const fileHandles = await window.showOpenFilePicker({ multiple: true });
  for (const fileHandle of fileHandles) {
    const file = await fileHandle.getFile();
    if (file) {
      await importRequestFromFile(file, models, context);
    }
  }
  await context.app.alert("Import finished successfully");
};
var prefix = "PL: ";
var workspaceActions = [
  {
    label: prefix + "Import Single",
    action: importFile
  },
  {
    label: prefix + "Import Multi",
    action: importFiles
  },
  {
    label: prefix + "Import Multi Recursively",
    action: importFilesRecursively
  },
  {
    label: prefix + "Import Multi, Group by Service",
    action: importFilesRecursivelyAsServices
  }
];
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  workspaceActions
});
