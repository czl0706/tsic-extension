const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const TESTBENCH_FILE = "tb.v";
const SIM_RESULT_DIR = "sim";
const GOLDEN_DIR = "golden";
const RESULT_FILE = "result.txt";
const LOG_FILE = "log.txt";
const VVP_FILE = "sim.vvp";
const WAVE_FILES = ["wave.vcd"];
const GOLDEN_WAVE_FILES = ["golden_wave.vcd"];
const DESCRIPTION_FILES = ["README.md", "description.md", "DESCRIPTION.md"];
const STUDENT_OUTPUT_BEGIN = "##SEC_STUDENT_CAN_SEE";
const STUDENT_OUTPUT_END = "##END_STUDENT_CAN_SEE";
const VAPORVIEW_EXTENSION_ID = "lramseyer.vaporview";
const INSTALL_VAPORVIEW_ACTION = "Install VaporView";

class FolderItem extends vscode.TreeItem {
  constructor(label, fullPath) {
    super(label, vscode.TreeItemCollapsibleState.Collapsed);
    this.fullPath = fullPath;
    this.contextValue = "playvFolder";
    this.iconPath = new vscode.ThemeIcon("folder");
  }
}

class ProblemItem extends vscode.TreeItem {
  constructor(label, fullPath, status, displayPath) {
    super(label, vscode.TreeItemCollapsibleState.Collapsed);
    this.labName = path.dirname(displayPath).replace(/\\/g, "/");
    this.displayPath = displayPath.replace(/\\/g, "/");
    this.fullPath = fullPath;
    this.status = status;
    this.contextValue = "playvProblem";
    this.description = status;
    this.tooltip = `${this.displayPath} (${status})`;
    this.iconPath = statusIcon(status);
    this.command = {
      command: "playv.showDescription",
      title: "Show Description",
      arguments: [this]
    };
  }
}

class ProblemActionItem extends vscode.TreeItem {
  constructor(label, icon, command, problem) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = "playvProblemAction";
    this.iconPath = new vscode.ThemeIcon(icon);
    this.command = {
      command,
      title: label,
      arguments: [problem]
    };
  }
}

class ProblemsProvider {
  constructor(extensionPath) {
    this.extensionPath = extensionPath;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    this.labs = [];
  }

  refresh() {
    this.labs = scanTree(resolveLabsRoot(this.extensionPath));
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element) {
    return element;
  }

  getChildren(element) {
    if (!element) {
      this.labs = scanTree(resolveLabsRoot(this.extensionPath));
      return this.labs.map((entry) => treeEntryToItem(entry));
    }

    if (element instanceof FolderItem) {
      const node = findTreeEntry(this.labs, element.fullPath);
      return (node?.children || []).map((entry) => treeEntryToItem(entry));
    }

    if (element instanceof ProblemItem) {
      const actions = [
        new ProblemActionItem("Description", "book", "playv.showDescription", element),
        new ProblemActionItem("Open Code", "code", "playv.openCode", element),
        new ProblemActionItem("Run Simulation", "play", "playv.runSimulation", element),
        new ProblemActionItem("Open Waveform", "pulse", "playv.openWaveform", element)
      ];

      if (hasGoldenDirectory(element.fullPath)) {
        actions.push(
          new ProblemActionItem("Golden Waveform", "symbol-event", "playv.openGoldenWaveform", element)
        );
      }

      return actions;
    }

    return [];
  }
}

function activate(context) {
  const output = vscode.window.createOutputChannel("playV");
  const provider = new ProblemsProvider(context.extensionPath);

  context.subscriptions.push(output);
  context.subscriptions.push(vscode.window.registerTreeDataProvider("playvProblems", provider));

  context.subscriptions.push(vscode.commands.registerCommand("playv.refresh", () => {
    provider.refresh();
  }));

  context.subscriptions.push(vscode.commands.registerCommand("playv.clearAllResults", async () => {
    const answer = await vscode.window.showWarningMessage(
      "Clear all playV simulation results?",
      { modal: true },
      "Clear Results"
    );
    if (answer !== "Clear Results") return;

    const labsRoot = resolveLabsRoot(context.extensionPath);
    const removed = clearAllSimulationResults(labsRoot);
    provider.refresh();
    vscode.window.showInformationMessage(`playV cleared ${removed} simulation result files.`);
  }));

  context.subscriptions.push(vscode.commands.registerCommand("playv.showDescription", async (item) => {
    const problem = await requireProblem(item);
    if (!problem) return;
    showProblemDescription(context, problem);
  }));

  context.subscriptions.push(vscode.commands.registerCommand("playv.openCode", async (item) => {
    const problem = await requireProblem(item);
    if (!problem) return;
    await openProblemCode(problem.fullPath);
  }));

  context.subscriptions.push(vscode.commands.registerCommand("playv.runSimulation", async (item) => {
    const problem = await requireProblem(item);
    if (!problem) return;

    output.clear();
    output.show(true);

    try {
      await runIverilogSimulation(problem, output);
    } catch (error) {
      output.appendLine("");
      output.appendLine(`[playV] ${error.message}`);
      vscode.window.showErrorMessage(`playV simulation failed: ${error.message}`);
    } finally {
      provider.refresh();
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand("playv.openWaveform", async (item) => {
    const problem = await requireProblem(item);
    if (!problem) return;

    const wavePath = findExistingWaveform(problem.fullPath);
    if (!fs.existsSync(wavePath)) {
      vscode.window.showWarningMessage(`No waveform found in ${path.join(problem.fullPath, SIM_RESULT_DIR)}`);
      return;
    }

    await suggestVaporViewForWaveform();
    await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(wavePath));
  }));


  context.subscriptions.push(vscode.commands.registerCommand("playv.openGoldenWaveform", async (item) => {
    const problem = await requireProblem(item);
    if (!problem) return;

    const wavePath = findExistingGoldenWaveform(problem.fullPath);
    if (!fs.existsSync(wavePath)) {
      vscode.window.showWarningMessage(`No golden waveform found in ${path.join(problem.fullPath, GOLDEN_DIR)}`);
      return;
    }

    await suggestVaporViewForWaveform();
    await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(wavePath));
  }));
}

function deactivate() {}

async function suggestVaporViewForWaveform() {
  if (vscode.extensions.getExtension(VAPORVIEW_EXTENSION_ID)) return;

  const choice = await vscode.window.showInformationMessage(
    "VaporView is recommended for opening VCD waveforms.",
    INSTALL_VAPORVIEW_ACTION,
    "Open Anyway"
  );

  if (choice === INSTALL_VAPORVIEW_ACTION) {
    await vscode.commands.executeCommand("workbench.extensions.installExtension", VAPORVIEW_EXTENSION_ID);
  }
}

function resolveLabsRoot(extensionPath) {
  const configured = resolveConfiguredPath(vscode.workspace.getConfiguration("playv").get("labsRoot", ""), extensionPath);
  const bundledFixture = path.join(extensionPath, "fixtures");
  const legacyBundledFixture = path.join(extensionPath, "fixtures", "labs");

  if (configured && fs.existsSync(configured)) return configured;
  const migratedConfigured = resolveMigratedLabsRoot(configured);
  if (migratedConfigured) return migratedConfigured;
  if (process.env.LABSROOT && fs.existsSync(process.env.LABSROOT)) return process.env.LABSROOT;
  if (fs.existsSync(bundledFixture)) return bundledFixture;
  if (fs.existsSync(legacyBundledFixture)) return legacyBundledFixture;

  return configured || process.env.LABSROOT || "/home/verilog/Desktop/dlab/public/labs";
}

function resolveMigratedLabsRoot(configured) {
  if (!configured) return "";

  const parent = path.dirname(configured);
  if (path.basename(configured).toLowerCase() === "labs" && path.basename(parent).toLowerCase() === "fixtures" && fs.existsSync(parent)) {
    return parent;
  }

  const siblingFixtures = path.join(path.dirname(configured), "fixtures");
  if (fs.existsSync(siblingFixtures)) return siblingFixtures;

  return "";
}

function resolveConfiguredPath(value, extensionPath) {
  if (!value) return "";

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "";
  let expanded = value
    .replace(/\$\{workspaceFolder\}/g, workspaceFolder)
    .replace(/\$\{extensionPath\}/g, extensionPath)
    .replace(/\$\{env:([^}]+)\}/g, (_, name) => process.env[name] || "");

  if (expanded.startsWith("~")) {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    expanded = path.join(home, expanded.slice(1));
  }

  if (path.isAbsolute(expanded)) return path.normalize(expanded);
  if (workspaceFolder) return path.resolve(workspaceFolder, expanded);
  return path.resolve(extensionPath, expanded);
}

function scanTree(labsRoot) {
  if (!fs.existsSync(labsRoot)) {
    return [];
  }

  return listDirectories(labsRoot)
    .map((dirPath) => scanTreeEntry(dirPath, labsRoot))
    .filter(Boolean);
}

function scanTreeEntry(dirPath, rootPath) {
  const displayPath = path.relative(rootPath, dirPath) || path.basename(dirPath);
  if (isProblemDirectory(dirPath)) {
    return {
      type: "problem",
      name: path.basename(dirPath),
      displayPath,
      fullPath: dirPath,
      status: readStatus(dirPath)
    };
  }

  const children = listDirectories(dirPath)
    .map((childPath) => scanTreeEntry(childPath, rootPath))
    .filter(Boolean);
  if (children.length === 0) return undefined;

  return {
    type: "folder",
    name: path.basename(dirPath),
    fullPath: dirPath,
    children
  };
}

function treeEntryToItem(entry) {
  if (entry.type === "problem") {
    return new ProblemItem(entry.name, entry.fullPath, entry.status, entry.displayPath);
  }
  return new FolderItem(entry.name, entry.fullPath);
}

function findTreeEntry(entries, fullPath) {
  for (const entry of entries) {
    if (entry.fullPath === fullPath) return entry;
    if (entry.children) {
      const found = findTreeEntry(entry.children, fullPath);
      if (found) return found;
    }
  }
  return undefined;
}

function isProblemDirectory(dirPath) {
  return fs.existsSync(path.join(dirPath, TESTBENCH_FILE)) || listVerilogFiles(dirPath).length > 0;
}

function listDirectories(dirPath) {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => path.join(dirPath, entry.name))
      .sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
  } catch {
    return [];
  }
}

function readStatus(problemPath) {
  const resultPath = path.join(problemPath, SIM_RESULT_DIR, RESULT_FILE);
  try {
    const text = fs.readFileSync(resultPath, "utf8").trim().toLowerCase();
    return text === "pass" ? "PASS" : "FAIL";
  } catch {
    return "NULL";
  }
}

function clearAllSimulationResults(labsRoot) {
  const problemDirs = findProblemDirectories(labsRoot);
  let removed = 0;

  for (const problemDir of problemDirs) {
    const simPath = path.join(problemDir, SIM_RESULT_DIR);
    for (const fileName of [RESULT_FILE, LOG_FILE, VVP_FILE, ...WAVE_FILES]) {
      const filePath = path.join(simPath, fileName);
      if (fs.existsSync(filePath)) {
        fs.rmSync(filePath, { force: true });
        removed += 1;
      }
    }
  }

  return removed;
}

function findProblemDirectories(labsRoot) {
  const found = [];
  const stack = [labsRoot];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || !fs.existsSync(current)) continue;

    if (isProblemDirectory(current)) {
      found.push(current);
      continue;
    }

    for (const child of listDirectories(current)) {
      stack.push(child);
    }
  }

  return found;
}

async function runIverilogSimulation(problem, output) {
  const simResultPath = path.join(problem.fullPath, SIM_RESULT_DIR);
  const resultPath = path.join(simResultPath, RESULT_FILE);
  const logPath = path.join(simResultPath, LOG_FILE);
  const vvpPath = path.join(simResultPath, VVP_FILE);
  const testbenchPath = path.join(problem.fullPath, TESTBENCH_FILE);
  const designFiles = listVerilogFiles(problem.fullPath).filter((filePath) => path.basename(filePath) !== TESTBENCH_FILE);
  const testbenchFiles = fs.existsSync(testbenchPath) ? [testbenchPath] : [];

  if (designFiles.length === 0) {
    throw new Error("No Verilog design files found in the problem folder.");
  }
  if (testbenchFiles.length === 0) {
    throw new Error(`No Icarus testbench found: ${TESTBENCH_FILE}.`);
  }

  fs.mkdirSync(simResultPath, { recursive: true });
  for (const filePath of [resultPath, logPath, vvpPath, ...WAVE_FILES.map((file) => path.join(simResultPath, file))]) {
    try {
      fs.rmSync(filePath, { force: true });
    } catch {
      // Best effort cleanup; stale files should not block a new run.
    }
  }

  output.appendLine(`[playV] ${problem.labName}/${problem.label}`);
  output.appendLine(`[playV] compile: iverilog -g2012 -o ${relativeForLog(problem.fullPath, vvpPath)} ...`);

  try {
    await runProcess(
      resolveToolPath("iverilog", "iverilogPath"),
      ["-g2012", "-o", vvpPath, ...designFiles, ...testbenchFiles],
      problem.fullPath,
      output
    );

    output.appendLine("");
    output.appendLine(`[playV] run: vvp ${relativeForLog(problem.fullPath, vvpPath)}`);
    await runProcess(resolveToolPath("vvp", "vvpPath"), [vvpPath], problem.fullPath, output, {
      filterStudentOutput: true
    });
  } catch (error) {
    writeFailResult(resultPath, logPath, error.message);
    throw error;
  }

  const status = readStatus(problem.fullPath);
  const wavePath = findExistingWaveform(problem.fullPath);
  output.appendLine("");
  output.appendLine(`[playV] result: ${status}`);
  output.appendLine(`[playV] log: ${relativeForLog(problem.fullPath, logPath)}`);
  if (fs.existsSync(wavePath)) {
    output.appendLine(`[playV] waveform: ${relativeForLog(problem.fullPath, wavePath)}`);
  }

  if (status !== "PASS") {
    throw new Error(`Simulation completed with ${status}.`);
  }
}

function runProcess(command, args, cwd, output, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false });
    const studentFilter = options.filterStudentOutput ? createStudentOutputFilter(output) : undefined;

    child.stdout.on("data", (chunk) => {
      if (studentFilter) {
        studentFilter.write(chunk.toString());
      } else {
        output.append(chunk.toString());
      }
    });
    child.stderr.on("data", (chunk) => output.append(chunk.toString()));
    child.on("error", (error) => {
      if (error.code === "ENOENT") {
        reject(new Error(`${command} was not found. Install Icarus Verilog or configure playv.iverilogPath/playv.vvpPath.`));
        return;
      }
      reject(error);
    });
    child.on("close", (code) => {
      if (studentFilter) studentFilter.flush();
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with code ${code}.`));
      }
    });
  });
}

function writeFailResult(resultPath, logPath, message) {
  try {
    fs.mkdirSync(path.dirname(resultPath), { recursive: true });
    fs.writeFileSync(resultPath, "fail\n", "utf8");
    fs.appendFileSync(logPath, `${message}\n`, "utf8");
  } catch {
    // If the filesystem is unavailable, keep the original simulation error.
  }
}

function createStudentOutputFilter(output) {
  let visible = false;
  let buffer = "";

  return {
    write(text) {
      buffer += text;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        handleLine(line.replace(/\r$/, ""));
        newlineIndex = buffer.indexOf("\n");
      }
    },
    flush() {
      if (buffer) {
        handleLine(buffer.replace(/\r$/, ""));
        buffer = "";
      }
    }
  };

  function handleLine(line) {
    if (line.includes(STUDENT_OUTPUT_BEGIN)) {
      visible = true;
      return;
    }
    if (line.includes(STUDENT_OUTPUT_END)) {
      visible = false;
      return;
    }
    if (visible) {
      output.appendLine(line);
    }
  }
}

function resolveToolPath(command, configKey) {
  const configured = resolveConfiguredPath(vscode.workspace.getConfiguration("playv").get(configKey, ""), "");
  if (configured && fs.existsSync(configured)) return configured;

  if (process.platform === "win32") {
    const wingetBin = path.join("C:\\", "iverilog", "bin", `${command}.exe`);
    if (fs.existsSync(wingetBin)) return wingetBin;
  }

  if (process.platform === "win32" && process.env.USERPROFILE) {
    const scoopBin = path.join(process.env.USERPROFILE, "scoop", "apps", "iverilog", "current", "bin", `${command}.exe`);
    if (fs.existsSync(scoopBin)) return scoopBin;

    const scoopShim = path.join(process.env.USERPROFILE, "scoop", "shims", `${command}.exe`);
    if (fs.existsSync(scoopShim)) return scoopShim;
  }

  return command;
}

function hasGoldenDirectory(problemPath) {
  return fs.existsSync(path.join(problemPath, GOLDEN_DIR));
}

function findExistingWaveform(problemPath) {
  for (const fileName of WAVE_FILES) {
    const wavePath = path.join(problemPath, SIM_RESULT_DIR, fileName);
    if (fs.existsSync(wavePath)) return wavePath;
  }
  return path.join(problemPath, SIM_RESULT_DIR, WAVE_FILES[0]);
}

function findExistingGoldenWaveform(problemPath) {
  for (const fileName of GOLDEN_WAVE_FILES) {
    const wavePath = path.join(problemPath, GOLDEN_DIR, fileName);
    if (fs.existsSync(wavePath)) return wavePath;
  }
  return path.join(problemPath, GOLDEN_DIR, GOLDEN_WAVE_FILES[0]);
}

function statusIcon(status) {
  if (status === "PASS") return new vscode.ThemeIcon("pass", new vscode.ThemeColor("testing.iconPassed"));
  if (status === "FAIL") return new vscode.ThemeIcon("error", new vscode.ThemeColor("testing.iconFailed"));
  return new vscode.ThemeIcon("circle-outline");
}

async function requireProblem(item) {
  if (item instanceof ProblemItem) {
    return item;
  }

  vscode.window.showWarningMessage("Select a playV problem first.");
  return undefined;
}

async function openProblemCode(problemPath) {
  const verilogFiles = listVerilogFiles(problemPath)
    .filter((filePath) => path.basename(filePath) !== TESTBENCH_FILE);

  if (verilogFiles.length === 0) {
    await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(problemPath));
    return;
  }

  for (const filePath of verilogFiles) {
    await vscode.window.showTextDocument(vscode.Uri.file(filePath), { preview: false });
  }
}

function showProblemDescription(context, problem) {
  const title = `${problem.labName}/${problem.label}`;
  const panel = vscode.window.createWebviewPanel(
    "playvDescription",
    title,
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(problem.fullPath)]
    }
  );

  panel.webview.html = renderProblemDescription(panel.webview, problem);
  panel.webview.onDidReceiveMessage(async (message) => {
    if (message.command === "openCode") {
      await vscode.commands.executeCommand("playv.openCode", problem);
    } else if (message.command === "runSimulation") {
      await vscode.commands.executeCommand("playv.runSimulation", problem);
    } else if (message.command === "openWaveform") {
      await vscode.commands.executeCommand("playv.openWaveform", problem);
    } else if (message.command === "openGoldenWaveform") {
      await vscode.commands.executeCommand("playv.openGoldenWaveform", problem);
    }
  }, undefined, context.subscriptions);
}

function renderProblemDescription(webview, problem) {
  const status = readStatus(problem.fullPath);
  const description = readProblemDescription(problem.fullPath) || buildFallbackDescription(problem);
  const nonce = getNonce();
  const body = markdownToHtml(description);
  const goldenButtons = hasGoldenDirectory(problem.fullPath)
    ? `
      <button data-command="openGoldenWaveform" class="secondary">Golden Waveform</button>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(problem.label)}</title>
  <style>
    body {
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      line-height: 1.55;
      margin: 0;
      padding: 24px 28px;
    }
    .header {
      border-bottom: 1px solid var(--vscode-panel-border);
      margin-bottom: 18px;
      padding-bottom: 16px;
    }
    .title-row {
      align-items: center;
      display: flex;
      gap: 12px;
      justify-content: space-between;
      margin-bottom: 14px;
    }
    h1 {
      font-size: 24px;
      font-weight: 600;
      margin: 0;
    }
    .status {
      border: 1px solid var(--vscode-badge-background);
      border-radius: 4px;
      color: var(--vscode-badge-foreground);
      background: var(--vscode-badge-background);
      font-size: 12px;
      font-weight: 600;
      padding: 2px 8px;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    button {
      background: var(--vscode-button-background);
      border: 0;
      border-radius: 3px;
      color: var(--vscode-button-foreground);
      cursor: pointer;
      font: inherit;
      padding: 6px 11px;
    }
    button:hover {
      background: var(--vscode-button-hoverBackground);
    }
    .secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    .secondary:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    .content {
      max-width: 980px;
    }
    h2 {
      border-bottom: 1px solid var(--vscode-panel-border);
      font-size: 18px;
      margin-top: 26px;
      padding-bottom: 6px;
    }
    code {
      background: var(--vscode-textCodeBlock-background);
      border-radius: 3px;
      font-family: var(--vscode-editor-font-family);
      padding: 1px 4px;
    }
    pre {
      background: var(--vscode-textCodeBlock-background);
      border-radius: 4px;
      overflow: auto;
      padding: 12px;
    }
    pre code {
      background: transparent;
      padding: 0;
    }
    a {
      color: var(--vscode-textLink-foreground);
    }
    table {
      border-collapse: collapse;
      margin: 14px 0 18px;
      width: auto;
    }
    th,
    td {
      border: 1px solid var(--vscode-panel-border);
      padding: 6px 10px;
      text-align: left;
    }
    th {
      background: var(--vscode-editorWidget-background);
      font-weight: 600;
    }
    hr {
      border: 0;
      border-top: 1px solid var(--vscode-panel-border);
      margin: 24px 0;
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="title-row">
      <h1>${escapeHtml(problem.labName)} / ${escapeHtml(problem.label)}</h1>
      <span class="status">${escapeHtml(status)}</span>
    </div>
    <div class="actions">
      <button data-command="openCode">Open Code</button>
      <button data-command="runSimulation" class="secondary">Run Simulation</button>
      <button data-command="openWaveform" class="secondary">Open Waveform</button>${goldenButtons}
    </div>
  </div>
  <main class="content"><h2>Problem Description</h2>${body}</main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.querySelectorAll("button[data-command]").forEach((button) => {
      button.addEventListener("click", () => {
        vscode.postMessage({ command: button.dataset.command });
      });
    });
  </script>
</body>
</html>`;
}

function readProblemDescription(problemPath) {
  for (const fileName of DESCRIPTION_FILES) {
    const filePath = path.join(problemPath, fileName);
    if (fs.existsSync(filePath)) {
      try {
        const text = fs.readFileSync(filePath, "utf8").trim();
        if (text) return text;
      } catch {
        return undefined;
      }
    }
  }

  return undefined;
}

function buildFallbackDescription(problem) {
  return `No problem description has been provided for \`${problem.labName}/${problem.label}\`.`;
}

function listVerilogFiles(designPath) {
  try {
    return fs.readdirSync(designPath, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.(v|sv)$/i.test(entry.name))
      .map((entry) => path.join(designPath, entry.name))
      .sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
  } catch {
    return [];
  }
}

function relativeForLog(fromPath, targetPath) {
  return path.relative(fromPath, targetPath) || targetPath;
}

function markdownToHtml(markdown) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const html = [];
  let inCodeBlock = false;
  let inList = false;

  for (let index = 0; index < lines.length; index++) {
    const rawLine = lines[index];
    const line = rawLine.trimEnd();

    if (line.startsWith("```")) {
      if (inList) {
        html.push("</ul>");
        inList = false;
      }
      html.push(inCodeBlock ? "</code></pre>" : "<pre><code>");
      inCodeBlock = !inCodeBlock;
      continue;
    }

    if (inCodeBlock) {
      html.push(`${escapeHtml(rawLine)}\n`);
      continue;
    }

    if (!line.trim()) {
      if (inList) {
        html.push("</ul>");
        inList = false;
      }
      continue;
    }

    if (/^\s*---+\s*$/.test(line)) {
      if (inList) {
        html.push("</ul>");
        inList = false;
      }
      html.push("<hr>");
      continue;
    }

    if (isMarkdownTableStart(lines, index)) {
      if (inList) {
        html.push("</ul>");
        inList = false;
      }

      const headers = splitMarkdownTableRow(lines[index]);
      html.push("<table>");
      html.push(`<thead><tr>${headers.map((cell) => `<th>${inlineMarkdown(cell)}</th>`).join("")}</tr></thead>`);
      html.push("<tbody>");
      index += 2;

      while (index < lines.length && isMarkdownTableRow(lines[index])) {
        const cells = splitMarkdownTableRow(lines[index]);
        html.push(`<tr>${cells.map((cell) => `<td>${inlineMarkdown(cell)}</td>`).join("")}</tr>`);
        index++;
      }

      html.push("</tbody></table>");
      index--;
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      if (inList) {
        html.push("</ul>");
        inList = false;
      }
      const level = heading[1].length;
      html.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }

    const bullet = line.match(/^-\s+(.+)$/);
    if (bullet) {
      if (!inList) {
        html.push("<ul>");
        inList = true;
      }
      html.push(`<li>${inlineMarkdown(bullet[1])}</li>`);
      continue;
    }

    if (inList) {
      html.push("</ul>");
      inList = false;
    }
    html.push(`<p>${inlineMarkdown(line)}</p>`);
  }

  if (inList) html.push("</ul>");
  if (inCodeBlock) html.push("</code></pre>");
  return html.join("\n");
}

function isMarkdownTableStart(lines, index) {
  return index + 1 < lines.length && isMarkdownTableRow(lines[index]) && isMarkdownTableSeparator(lines[index + 1]);
}

function isMarkdownTableRow(line) {
  const trimmed = line.trim();
  return trimmed.startsWith("|") && trimmed.endsWith("|") && trimmed.slice(1, -1).includes("|");
}

function isMarkdownTableSeparator(line) {
  if (!isMarkdownTableRow(line)) return false;
  return splitMarkdownTableRow(line).every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function splitMarkdownTableRow(line) {
  return line.trim().slice(1, -1).split("|").map((cell) => cell.trim());
}

function inlineMarkdown(text) {
  return escapeHtml(text).replace(/`([^`]+)`/g, "<code>$1</code>");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function getNonce() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

module.exports = {
  activate,
  deactivate
};
