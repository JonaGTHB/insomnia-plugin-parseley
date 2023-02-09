import {Context, Request, RequestGroup, WorkspaceAction, WorkspaceActionModels} from "insomnia-plugin";

type LinesByRequestWithNameAndMethod = {
    requestName: string | null,
    requestLines: Array<string>,
    requestMethod: string | null,
}

const services = new Map();

enum AuthorizationType {
    BASIC = "Basic",
    BASIC_USERNAME_PASSWORD = "BasicUP",
    BEARER = "Bearer",
}

enum InsomniaResourceType {
    REQUEST = "request",
    REQUEST_GROUP = "request_group",
}

enum InsomniaActionType {
    EXPORT = "export",
}

async function parseFileTextIntoLines(fileContent: string): Promise<Array<string>> {
    return fileContent.split(/\r?\n/).filter(line => {
        line = line.trim();
        return !(line.startsWith('Accept') || line.startsWith('Cache-Control') || line.startsWith('Content-Type') || line.startsWith("x-") || line === "");
    });
}

async function getRequestMethodByLine(line: string): Promise<string | null> {
    const requestMethods = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"];
    for (const requestMethod of requestMethods) {
        if (line.startsWith(requestMethod)) {
            return requestMethod
        }
    }
    return null;
}

async function partitionFileLinesByRequestAndExtractBasicData(lines: Array<string>): Promise<Array<LinesByRequestWithNameAndMethod>> {
    let isParsingRequest = false;
    let requestLines = [];
    const requestLinesWithExtraData: Array<LinesByRequestWithNameAndMethod> = [];
    let requestMethod = null;
    let requestName = null;
    for (let i = 0; i < lines.length; i++) {
        let line = lines[i];
        const isRequestStartLine = await getRequestMethodByLine(line);
        if (isRequestStartLine !== null) {
            line = line.replace(isRequestStartLine, "").trim();
            if (isParsingRequest) {
                requestLines = requestLines.filter(line => !line.trim().startsWith('###'));
                requestLinesWithExtraData.push({
                    requestMethod: requestMethod,
                    requestName: requestName,
                    requestLines: requestLines
                });
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
            requestLines = requestLines.filter(line => !line.trim().startsWith('###'));
            requestLinesWithExtraData.push({
                requestMethod: requestMethod,
                requestName: requestName,
                requestLines: requestLines
            });
        }
    }
    return requestLinesWithExtraData;
}

async function extractNameFromComment(lines: Array<string>, index: number): Promise<string | null> {
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

async function extractAuthorizationFromLine(line: string) {
    const authWithType = line.replace("Authorization:", "").trim();
    if (authWithType.startsWith(AuthorizationType.BASIC)) {
        let auth = authWithType.replace(AuthorizationType.BASIC, "").trim();
        if (auth.split(" ").length === 2) {
            const [username, password] = auth.split(" ");
            return {
                type: AuthorizationType.BASIC_USERNAME_PASSWORD,
                auth: {
                    username: username,
                    password: password,
                }
            }
        } else {
            return {
                type: AuthorizationType.BASIC,
                auth: auth,
            }
        }
    } else if (authWithType.startsWith(AuthorizationType.BEARER)) {
        let auth = authWithType.replace(AuthorizationType.BEARER, "").trim();
        return {
            type: AuthorizationType.BEARER,
            auth: auth,
        }
    }
}

function insomniaIdGenerator() {
    let index = 0;

    return function generateInsomniaId() {
        index += 1;
        return `__INSOMNIA_${index}__`;
    };
}

function getCurrentWorkspace(models: WorkspaceActionModels) {
    return models.workspace;
}

let generateInsomniaId = insomniaIdGenerator();

async function extractRequestsFromLinesByRequest(linesByRequest: Array<LinesByRequestWithNameAndMethod>, parentId: string, fileName: string) {
    let url = null;
    let auth: null | Awaited<ReturnType<typeof extractAuthorizationFromLine>> = null;
    let body = "";
    const requests: Array<Partial<Request> & { _type: InsomniaResourceType.REQUEST }> = [];
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
        let request: Partial<Request> & { _type: InsomniaResourceType.REQUEST } = {
            _id: generateInsomniaId(),
            _type: InsomniaResourceType.REQUEST,
            body: {
                mimeType: "application/json",
                text: JSON.parse(JSON.stringify(body)),
            },
            name: fileName,
            description: requestsAsLines.requestName ?? "",
            method: requestsAsLines.requestMethod,
            url: url ?? "",
            parentId: parentId,
        }
        if (auth !== null) {
            if (auth.type === AuthorizationType.BASIC) {
                request.authentication = auth.auth;
            } else {
                if (auth.type === AuthorizationType.BASIC_USERNAME_PASSWORD) {
                    request.authentication = auth.auth
                } else {
                    request.authentication = {
                        type: "bearer",
                        token: auth.auth,
                    }
                }
            }
        }
        requests.push(request);
    }
    return requests;
}

async function correctTemplateMarker(line: string) {
    const matches = line.match(/{{ *[a-zA-Z]* *}}/g);
    if (matches === null) {
        return line;
    }
    matches.forEach(match => {
        match = match.trim();
        const text = match.replace("{{", "").replace("}}", "").trim();
        line = line.replace(match, `{{_.${text}}}`);
    });
    return line;
}

async function handleServiceImport(files: Array<any>, models: WorkspaceActionModels, context: Context, service: string) {
    const workspace = getCurrentWorkspace(models);
    let serviceGroup: Partial<RequestGroup & { _type: InsomniaResourceType.REQUEST_GROUP }> = {
        parentId: workspace._id,
        name: service,
        _type: InsomniaResourceType.REQUEST_GROUP,
        _id: generateInsomniaId(),
    };
    const allChildren: Partial<RequestGroup & { _type: InsomniaResourceType.REQUEST_GROUP } | Request & { _type: InsomniaResourceType.REQUEST }>[] = [serviceGroup];

    for (const file of files) {
        const fileName = file.name.replace(".http", "");
        let requestGroup: Partial<RequestGroup & { _type: InsomniaResourceType.REQUEST_GROUP }> = {
            parentId: serviceGroup._id,
            name: fileName,
            _type: InsomniaResourceType.REQUEST_GROUP,
            _id: generateInsomniaId(),
        };
        const fileHandle = await file.handle.getFile();
        const fileLines = await parseFileTextIntoLines(await fileHandle.text());
        const LinesByRequestsWithExtraData: Array<LinesByRequestWithNameAndMethod> = await partitionFileLinesByRequestAndExtractBasicData(fileLines);
        const insomniaRequests = await extractRequestsFromLinesByRequest(LinesByRequestsWithExtraData, requestGroup._id, fileName);
        let all = [requestGroup, ...insomniaRequests];
        allChildren.push(...all);
    }
    let resources = [...allChildren, workspace];
    let insomniaExportLike = {
        resources,
        __export_format: 4,
        _type: InsomniaActionType.EXPORT,
    };
    await context.data.import.raw(JSON.stringify(insomniaExportLike), {workspaceId: workspace._id});
}

async function importRequestFromFile(file: File, models: WorkspaceActionModels, context: Context, service?: string) {
    const fileContent = await file.text();
    const fileLines = await parseFileTextIntoLines(fileContent);

    const requests: Array<LinesByRequestWithNameAndMethod> = await partitionFileLinesByRequestAndExtractBasicData(fileLines);

    const workspace = getCurrentWorkspace(models);
    let requestGroup: Partial<RequestGroup & { _type: InsomniaResourceType.REQUEST_GROUP }> = {
        parentId: workspace._id,
        name: file.name.replace(".http", ""),
        _type: InsomniaResourceType.REQUEST_GROUP,
        _id: generateInsomniaId(),
    };

    const insomniaRequests = await extractRequestsFromLinesByRequest(requests, requestGroup._id, file.name);
    let all = [requestGroup, ...insomniaRequests];
    let resources = [...all, workspace];

    let insomniaExportLike = {
        resources,
        __export_format: 4,
        _type: InsomniaActionType.EXPORT,
    };
    await context.data.import.raw(JSON.stringify(insomniaExportLike), {workspaceId: workspace._id});
}

let importFile: WorkspaceAction["action"] =
    async function importFile(context, models) {
        // @ts-ignore next-line
        const [fileHandle] = await window.showOpenFilePicker();
        const file = await fileHandle.getFile();
        if (file) {
            await importRequestFromFile(file, models, context);
        }
        await context.app.alert("Import finished successfully");
    }

async function listAllFilesAndDirs(dirHandle) {
    const files = [];
    for await (let [name, handle] of dirHandle) {
        const {kind} = handle;
        if (handle.kind === 'directory') {
            files.push(...await listAllFilesAndDirs(handle));
        } else {
            if (name.endsWith(".http")) {
                files.push({name, handle, kind});
            }
        }
    }
    return files;
}

async function listAllFilesAndAssociateToService(dirHandle, service = "", isFirstSubDir = true) {
    const files = [];
    for await (let [name, handle] of dirHandle) {
        const {kind} = handle;
        if (handle.kind === 'directory') {
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
                files.push({name, handle, kind, service});
            }
        }
    }
    return files;
}

let importFilesRecursively: WorkspaceAction["action"] =
    async function importFile(context, models) {
        // @ts-ignore next-line
        const directoryHandle = await window.showDirectoryPicker()
        const files = await listAllFilesAndDirs(directoryHandle);
        for (const file of files) {
            await importRequestFromFile(await file.handle.getFile(), models, context);
        }
        await context.app.alert("Import finished successfully");
    }
let importFilesRecursivelyAsServices: WorkspaceAction["action"] =
    async function importFile(context, models) {
        // @ts-ignore next-line
        const directoryHandle = await window.showDirectoryPicker()
        let files = await listAllFilesAndAssociateToService(directoryHandle);
        services.forEach(async (value, key) => {
            const filesForService = files.filter(file => file.service === key);
            await handleServiceImport(filesForService, models, context, key);
        });
        await context.app.alert("Import finished successfully");
    }


let importFiles: WorkspaceAction["action"] =
    async function importFile(context, models) {
        // @ts-ignore next-line
        const fileHandles = await window.showOpenFilePicker({multiple: true});
        for (const fileHandle of fileHandles) {
            const file = await fileHandle.getFile();
            if (file) {
                await importRequestFromFile(file, models, context);
            }
        }
        await context.app.alert("Import finished successfully");
    }

const prefix = "PL: ";
export const workspaceActions: Array<WorkspaceAction> = [
    {
        label: prefix + "Import Single",
        action: importFile,
    },
    {
        label: prefix + "Import Multi",
        action: importFiles,
    },
    {
        label: prefix + "Import Multi Recursively",
        action: importFilesRecursively,
    },
    {
        label: prefix + "Import Multi, Group by Service",
        action: importFilesRecursivelyAsServices,
    },
];