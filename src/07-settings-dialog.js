import { CONFIG, PAGE } from "./01-config.js";
import { elements, state } from "./02-state.js";
import { PROMPT_TEMPLATE_DEFAULT, saveSettings, settings } from "./06-settings.js";
import { Core } from "./08-core.js";
import { addGreetingItem } from "./13-greetings.js";
import { loadGreetings } from "./15-settings-deferred.js";
export function createSettingsDialog() {
  const dialog = document.createElement("div");
  dialog.id = "boss-settings-dialog";
  dialog.style.cssText = `
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        width: clamp(300px, 90vw, 840px);
        height: 80vh;
        background: #ffffff;
        border-radius: 12px;
        box-shadow: 0 10px 30px rgba(0,0,0,0.15);
        z-index: 999999;
        display: none;
        flex-direction: column;
        font-family: 'Segoe UI', sans-serif;
        overflow: hidden;
        transition: all 0.3s ease;
    `;

  dialog.innerHTML += `
        <style>
            #boss-settings-dialog {
                opacity: 0;
                transform: translate(-50%, -50%) scale(0.95);
            }
            #boss-settings-dialog.active {
                opacity: 1;
                transform: translate(-50%, -50%) scale(1);
            }
            .setting-item {
                transition: border-color 0.2s ease;
            }
            .settings-card .setting-item:last-child {
                border-bottom: none;
            }
            #apply-interval-input,
            #max-apply-input {
                -moz-appearance: textfield;
                appearance: textfield;
            }
            #apply-interval-input::-webkit-outer-spin-button,
            #apply-interval-input::-webkit-inner-spin-button,
            #max-apply-input::-webkit-outer-spin-button,
            #max-apply-input::-webkit-inner-spin-button {
                -webkit-appearance: none;
                margin: 0;
            }
            #boss-settings-dialog .settings-btn {
                height: 32px;
                padding: 0 16px;
                border-radius: 4px;
                border: 1px solid transparent;
                font-size: 14px;
                font-weight: 500;
                line-height: 1;
                cursor: pointer;
                box-sizing: border-box;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                white-space: nowrap;
                transition: background-color 0.2s, border-color 0.2s, color 0.2s;
            }
            #boss-settings-dialog .settings-btn:disabled {
                opacity: 0.6;
                cursor: not-allowed;
            }
            #boss-settings-dialog .settings-btn-primary {
                background: #1a73e8;
                border-color: #1a73e8;
                color: #ffffff;
            }
            #boss-settings-dialog .settings-btn-primary:hover {
                background: #1557b0;
                border-color: #1557b0;
            }
            #boss-settings-dialog .settings-btn-secondary {
                background: #e8f0fe;
                border-color: #a8c7fa;
                color: #1a73e8;
            }
            #boss-settings-dialog .settings-btn-secondary:hover {
                background: #d2e3fc;
            }
            #boss-settings-dialog .settings-btn-neutral {
                background: #ffffff;
                border-color: #dadce0;
                color: #5f6368;
            }
            #boss-settings-dialog .settings-btn-neutral:hover {
                background: #f1f3f4;
            }
            #boss-settings-dialog .settings-btn-danger {
                background: #ffffff;
                border-color: #ff4d4f;
                color: #ff4d4f;
            }
            #boss-settings-dialog .settings-btn-danger:hover {
                background: #fff1f0;
            }
            .multi-select-container {
                position: relative;
                width: 100%;
                margin-top: 10px;
            }
            .multi-select-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 10px;
                border-radius: 8px;
                border: 1px solid #d1d5db;
                background: white;
                cursor: pointer;
                transition: all 0.2s ease;
            }
            .multi-select-header:hover {
                border-color: rgba(26, 115, 232, 0.7);
            }
            .multi-select-options {
                position: absolute;
                top: 100%;
                left: 0;
                right: 0;
                max-height: 200px;
                overflow-y: auto;
                border-radius: 8px;
                border: 1px solid #d1d5db;
                background: white;
                z-index: 100;
                box-shadow: 0 4px 10px rgba(0,0,0,0.1);
                display: none;
            }
            .multi-select-option {
                padding: 10px;
                cursor: pointer;
                transition: all 0.2s ease;
            }
            .multi-select-option:hover {
                background-color: rgba(26, 115, 232, 0.05);
            }
            .multi-select-option.selected {
                background-color: rgba(26, 115, 232, 0.1);
            }
            .multi-select-clear {
                color: #666;
                cursor: pointer;
                margin-left: 5px;
            }
            .multi-select-clear:hover {
                color: #333;
            }
        </style>
    `;

  // 设置不再分标签页：所有分组按顺序排在同一张滚动页面里
  const dialogHeader = createDialogHeader(
    "设置",
    "boss-settings-dialog",
    null,
    closeSettingsDialog,
  );

  const dialogContent = document.createElement("div");
  dialogContent.style.cssText = `
        padding: 18px;
        background: #f8f9fa;
        flex: 1;
        overflow-y: auto;
        scrollbar-width: thin;
        scrollbar-color: rgba(26, 115, 232, 0.5) rgba(0, 0, 0, 0.05);
    `;

  dialogContent.innerHTML += `
    <style>
        #boss-settings-dialog ::-webkit-scrollbar {
            width: 8px;
            height: 8px;
        }
        #boss-settings-dialog ::-webkit-scrollbar-track {
            background: rgba(0,0,0,0.05);
            border-radius: 10px;
            margin: 8px 0;
        }
        #boss-settings-dialog ::-webkit-scrollbar-thumb {
            background: rgba(26, 115, 232, 0.5);
            border-radius: 10px;
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
            transition: all 0.2s ease;
        }
        #boss-settings-dialog ::-webkit-scrollbar-thumb:hover {
            background: rgba(26, 115, 232, 0.7);
            box-shadow: 0 1px 5px rgba(0,0,0,0.15);
        }
    </style>
    `;

  const generalSettingsPanel = document.createElement("div");
  generalSettingsPanel.id = "general-settings-panel";

  const jobSettingsPanel = document.createElement("div");
  jobSettingsPanel.id = "job-settings-panel";

  const chatSettingsPanel = document.createElement("div");
  chatSettingsPanel.id = "chat-settings-panel";

  const apiGroup = createSettingsGroup("AI API 配置");
  [
    {
      id: "ai-api-url-input",
      label: "API 地址",
      desc: "兼容 OpenAI 协议的接口地址",
      placeholder: "https://api.deepseek.com/v1/chat/completions",
    },
    {
      id: "ai-api-key-input",
      label: "API Key",
      desc: "仅保存在本地浏览器，请勿在公用电脑使用",
      placeholder: "sk-xxx",
      password: true,
    },
    {
      id: "ai-model-input",
      label: "模型名称",
      desc: "默认 deepseek-chat",
      placeholder: "deepseek-chat",
    },
  ].forEach(function (cf) {
    const field = createSettingItem(cf.label, cf.desc, () => document.getElementById(cf.id));
    var ip = Object.assign(document.createElement("input"), {
      type: cf.password ? "password" : "text",
      id: cf.id,
      placeholder: cf.placeholder,
    });
    ip.style.cssText =
      "width:100%;padding:9px 14px;border-radius:6px;border:1px solid transparent;background:#f1f3f4;font-size:13px;margin-top:12px;box-sizing:border-box;outline:none;transition:all 0.2s;";
    addFocusBlurEffects(ip);
    field.settingItem.append(ip);
    apiGroup.card.append(field.settingItem);
  });

  var apiFooter = document.createElement("div");
  apiFooter.style.cssText = "padding:10px 0 14px;";
  var btnRow = document.createElement("div");
  btnRow.style.cssText = "display:flex;gap:8px;";
  var ab = createSettingsButton("保存 API 配置", "primary");
  ab.style.flex = "1";
  function collectApi() {
    var a = document.getElementById("ai-api-url-input");
    if (a) settings.aiApiUrl = a.value.trim();
    var b = document.getElementById("ai-api-key-input");
    if (b) settings.aiApiKey = b.value.trim();
    var c = document.getElementById("ai-model-input");
    if (c) settings.aiModel = c.value.trim() || "deepseek-chat";
  }
  ab.addEventListener("click", function () {
    collectApi();
    saveSettings();
    showNotification("API 配置已保存");
  });
  var tb = createSettingsButton("测试连接", "secondary");
  tb.style.flex = "1";
  tb.addEventListener("click", async function () {
    collectApi();
    saveSettings();
    if (!settings.aiApiKey) {
      showNotification("请先填写 API Key", "error");
      return;
    }
    tb.disabled = true;
    tb.textContent = "测试中...";
    try {
      var r = await Core.requestAi("你好，请只回复两个字：可用", null, {
        retries: 0,
        label: "连接测试",
      });
      showNotification(
        r ? "连接成功：" + String(r).slice(0, 20) : "连接失败，请检查配置",
        "success",
      );
    } catch (e) {
      showNotification("连接失败：" + e.message, "error");
    } finally {
      tb.disabled = false;
      tb.textContent = "测试连接";
    }
  });
  btnRow.appendChild(ab);
  btnRow.appendChild(tb);
  apiFooter.appendChild(btnRow);
  apiGroup.card.append(apiFooter);

  // 投递提示词作为设置页里的一项，点击后在弹窗内打开编辑器
  const promptGroup = createSettingsGroup("投递提示词");
  const promptSettingResult = createSettingItem(
    "提示词内容",
    "判定用的简历、投递要求与规则；只有 {jobTitle} / {jobDescription} 会被自动替换",
    () => document.getElementById("edit-prompt-btn"),
  );
  const editPromptBtn = createSettingsButton("编辑提示词", "secondary");
  editPromptBtn.id = "edit-prompt-btn";
  editPromptBtn.style.flexShrink = "0";
  promptSettingResult.descriptionContainer.append(editPromptBtn);
  promptGroup.card.append(promptSettingResult.settingItem);
  generalSettingsPanel.append(apiGroup.group, promptGroup.group);

  const greetingsSettingResult = createSettingItem(
    "打招呼列表",
    "第一行填网页自动发送的打招呼语；最后一条我方消息与它一致时，脚本才依次发送第二行及以后的内容",
    () => document.getElementById("greetings-container"),
  );

  const greetingsSetting = greetingsSettingResult.settingItem;
  greetingsSetting.style.padding = "16px 0";
  const greetingsContainer = document.createElement("div");
  greetingsContainer.id = "greetings-container";
  greetingsContainer.style.cssText = `
        width: 100%;
        margin-top: 14px;
    `;

  const greetingsList = document.createElement("div");
  greetingsList.id = "greetings-list";

  const addGreetingBtn = createSettingsButton("添加一条", "secondary", () => {
    addGreetingItem();
  });
  addGreetingBtn.style.flexShrink = "0";

  // 添加按钮放在标题右侧，列表在下方
  greetingsSettingResult.descriptionContainer.append(addGreetingBtn);
  greetingsContainer.append(greetingsList);
  greetingsSetting.append(greetingsContainer);

  const autoSendResumeSettingResult = createSettingItem(
    "自动发送附件简历",
    "开启后系统将自动发送附件简历给 HR",
    () => document.querySelector("#toggle-auto-send-resume input"),
  );

  const autoSendResumeSetting = autoSendResumeSettingResult.settingItem;
  const autoSendResumeDescriptionContainer = autoSendResumeSettingResult.descriptionContainer;

  const autoSendResumeToggle = createToggleSwitch(
    "auto-send-resume",
    settings.useAutoSendResume,
    (checked) => {
      settings.useAutoSendResume = checked;
    },
    true,
  );

  autoSendResumeDescriptionContainer.append(autoSendResumeToggle);

  const excludeHeadhuntersSettingResult = createSettingItem(
    "投递时排除猎头",
    "开启后将不会向猎头职位自动投递简历",
    () => document.querySelector("#toggle-exclude-headhunters input"),
  );

  const excludeHeadhuntersSetting = excludeHeadhuntersSettingResult.settingItem;
  const excludeHeadhuntersDescriptionContainer =
    excludeHeadhuntersSettingResult.descriptionContainer;

  const excludeHeadhuntersToggle = createToggleSwitch(
    "exclude-headhunters",
    settings.excludeHeadhunters,
    (checked) => {
      settings.excludeHeadhunters = checked;
    },
    true,
  );

  excludeHeadhuntersDescriptionContainer.append(excludeHeadhuntersToggle);

  const autoAcceptCardSettingResult = createSettingItem(
    "自动同意交换",
    "HR 发来交换联系方式卡片时自动点「同意」。默认关闭 —— 开启后会把你的联系方式交给对方",
    () => document.querySelector("#toggle-auto-accept-card input"),
  );

  const autoAcceptCardSetting = autoAcceptCardSettingResult.settingItem;
  const autoAcceptCardDescriptionContainer = autoAcceptCardSettingResult.descriptionContainer;

  const autoAcceptCardToggle = createToggleSwitch(
    "auto-accept-card",
    settings.autoAcceptCard,
    (checked) => {
      settings.autoAcceptCard = checked;
    },
    true,
  );

  autoAcceptCardDescriptionContainer.append(autoAcceptCardToggle);

  const imageResumeSettingResult = createSettingItem(
    "发送图片简历",
    "首次沟通发送图片简历（需先选择JPG格式图片）",
    () => document.querySelector("#toggle-auto-send-image-resume input"),
  );

  const imageResumeSetting = imageResumeSettingResult.settingItem;
  const imageResumeDescriptionContainer = imageResumeSettingResult.descriptionContainer;

  if (!state.settings.imageResumes) {
    state.settings.imageResumes = [];
  }

  const fileInputContainer = document.createElement("div");
  fileInputContainer.style.cssText = `
        display: flex;
        flex-direction: column;
        gap: 10px;
        width: 100%;
        margin-top: 10px;
    `;

  const addResumeBtn = createSettingsButton("添加图片简历", "secondary");
  addResumeBtn.id = "add-image-resume-btn";
  addResumeBtn.style.alignSelf = "flex-start";

  const fileNameDisplay = document.createElement("div");
  fileNameDisplay.id = "image-resume-filename";
  fileNameDisplay.style.cssText = `
        flex: 1;
        padding: 8px;
        border-radius: 6px;
        border: 1px solid #d1d5db;
        background: #f8fafc;
        color: #334155;
        font-size: 14px;
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
    `;
  const resumeCount = state.settings.imageResumes ? state.settings.imageResumes.length : 0;
  fileNameDisplay.textContent = resumeCount > 0 ? `已上传 ${resumeCount} 个简历` : "未选择文件";

  const autoSendImageResumeToggle = (() => {
    const hasImageResumes = state.settings.imageResumes && state.settings.imageResumes.length > 0;
    const isValidState = hasImageResumes && settings.useAutoSendImageResume;
    if (!hasImageResumes) settings.useAutoSendImageResume = false;

    return createToggleSwitch(
      "auto-send-image-resume",
      isValidState,
      (checked) => {
        if (checked && (!state.settings.imageResumes || state.settings.imageResumes.length === 0)) {
          showNotification("请先选择图片文件", "error");

          const slider = document.querySelector("#toggle-auto-send-image-resume .toggle-slider");
          const container = document.querySelector("#toggle-auto-send-image-resume .toggle-switch");

          container.style.backgroundColor = "#e5e7eb";
          slider.style.transform = "translateX(0)";
          document.querySelector("#toggle-auto-send-image-resume input").checked = false;
        }
        settings.useAutoSendImageResume = checked;
        return true;
      },
      true,
    );
  })();

  const hiddenFileInput = document.createElement("input");
  hiddenFileInput.id = "image-resume-input";
  hiddenFileInput.type = "file";
  hiddenFileInput.accept = ".jpg,.jpeg";
  hiddenFileInput.style.display = "none";

  const uploadedResumesContainer = document.createElement("div");
  uploadedResumesContainer.id = "uploaded-resumes-container";
  uploadedResumesContainer.style.cssText = `
        display: flex;
        flex-direction: column;
        gap: 8px;
        width: 100%;
    `;

  function renderResumeItem(resume) {
    const resumeItem = document.createElement("div");
    resumeItem.style.cssText = `
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 8px 12px;
            border-radius: 6px;
            background: rgba(0, 0, 0, 0.05);
            font-size: 14px;
        `;

    const fileNameSpan = document.createElement("span");
    fileNameSpan.textContent = resume.path;
    fileNameSpan.style.cssText = `
            flex: 1;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            margin-right: 8px;
        `;

    const deleteBtn = createSettingsButton("删除", "danger");
    deleteBtn.style.width = "56px";
    deleteBtn.style.padding = "0";

    deleteBtn.addEventListener("click", () => {
      // 按对象引用实时定位，不能用渲染时捕获的 index：
      // 删掉一项后，其余按钮仍持有旧下标，再点删除会删错项。
      // 若数组被整体替换过导致引用失配，退回按 path 定位（添加时已保证唯一）。
      const list = state.settings.imageResumes;
      let idx = list.indexOf(resume);
      if (idx === -1) idx = list.findIndex((r) => r.path === resume.path);
      if (idx === -1) return;
      list.splice(idx, 1);

      resumeItem.remove();

      if (state.settings.imageResumes.length === 0) {
        state.settings.useAutoSendImageResume = false;
        const toggleInput = document.querySelector("#toggle-auto-send-image-resume input");
        if (toggleInput) {
          toggleInput.checked = false;
          toggleInput.dispatchEvent(new Event("change"));
        }
      }

      // 删掉图片简历属于"设置变了"，必须显式落盘
      saveSettings();
    });

    resumeItem.appendChild(fileNameSpan);
    resumeItem.appendChild(deleteBtn);

    return resumeItem;
  }

  if (state.settings.imageResumes && state.settings.imageResumes.length > 0) {
    state.settings.imageResumes.forEach((resume) => {
      const resumeItem = renderResumeItem(resume);
      uploadedResumesContainer.appendChild(resumeItem);
    });
  }

  addResumeBtn.addEventListener("click", () => {
    if (state.settings.imageResumes.length >= 10) {
      showNotification("最多添加 10 个图片简历", "error");
    } else {
      hiddenFileInput.click();
    }
  });

  hiddenFileInput.addEventListener("change", (e) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];

      const fileName = file.name.toLowerCase();
      if (!fileName.endsWith(".jpg") && !fileName.endsWith(".jpeg")) {
        showNotification("仅支持 JPG/JPEG 格式的图片文件", "error");
        hiddenFileInput.value = "";
        return;
      }

      const isDuplicate = state.settings.imageResumes.some((resume) => resume.path === file.name);
      if (isDuplicate) {
        showNotification("该文件名已存在", "error");
        return;
      }

      const reader = new FileReader();
      reader.onload = function (event) {
        const newResume = {
          path: file.name,
          data: event.target.result,
        };

        state.settings.imageResumes.push(newResume);

        const resumeItem = renderResumeItem(newResume);
        uploadedResumesContainer.appendChild(resumeItem);

        if (!state.settings.useAutoSendImageResume) {
          state.settings.useAutoSendImageResume = true;
          const toggleInput = document.querySelector("#toggle-auto-send-image-resume input");
          if (toggleInput) {
            toggleInput.checked = true;
            toggleInput.dispatchEvent(new Event("change"));
          }
        }

        // 新增图片简历属于"设置变了"，必须显式落盘
        saveSettings();
      };
      reader.readAsDataURL(file);
    }
  });

  fileInputContainer.append(addResumeBtn, uploadedResumesContainer, hiddenFileInput);
  imageResumeDescriptionContainer.append(autoSendImageResumeToggle);
  imageResumeSetting.append(fileInputContainer);

  const recruiterStatusSettingResult = createSettingItem(
    "投递招聘者状态（多选）",
    "筛选活跃状态符合要求的招聘者进行投递",
    () => document.querySelector("#recruiter-status-select .select-header"),
  );

  const recruiterStatusSetting = recruiterStatusSettingResult.settingItem;
  // 这一行是「左标题 + 右多选」的横向布局；窗口太窄时多选自动换到下一行
  recruiterStatusSetting.style.flexDirection = "row";
  recruiterStatusSetting.style.flexWrap = "wrap";
  recruiterStatusSetting.style.alignItems = "center";
  recruiterStatusSetting.style.gap = "16px 24px";
  recruiterStatusSettingResult.descriptionContainer.style.flex = "1 1 260px";
  recruiterStatusSettingResult.descriptionContainer.style.minWidth = "0";

  const statusSelect = document.createElement("div");
  statusSelect.id = "recruiter-status-select";
  statusSelect.className = "custom-select";
  statusSelect.style.cssText = `
        position: relative;
        flex: 0 1 440px;
        width: 440px;
        max-width: 100%;
        margin-left: auto;
        margin-top: 0;
    `;

  const statusHeader = document.createElement("div");
  statusHeader.className = "select-header";
  statusHeader.style.cssText = `
        display: flex;
        justify-content: space-between;
        align-items: center;
        height: 36px;
        padding: 0 11px;
        border-radius: 6px;
        border: 1px solid #dcdfe6;
        background: white;
        cursor: pointer;
        transition: all 0.2s ease;
        box-sizing: border-box;
    `;

  const statusDisplay = document.createElement("div");
  statusDisplay.className = "select-value";
  statusDisplay.style.cssText = `
        flex: 1;
        text-align: left;
        color: #606266;
        font-size: 14px;
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
    `;
  statusDisplay.textContent = getStatusDisplayText();

  const statusIcon = document.createElement("div");
  statusIcon.className = "select-icon";
  statusIcon.innerHTML =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
  statusIcon.style.cssText = `
        margin-left: 10px;
        color: #a8abb2;
        display: flex;
        align-items: center;
        transition: transform 0.2s ease;
    `;

  statusHeader.append(statusDisplay, statusIcon);

  const statusOptions = document.createElement("div");
  statusOptions.className = "select-options";
  statusOptions.style.cssText = `
        position: absolute;
        top: calc(100% + 12px);
        left: 0;
        right: 0;
        max-height: 240px;
        overflow-y: auto;
        border-radius: 4px;
        border: 1px solid #e4e7ed;
        background: white;
        z-index: 100;
        box-shadow: 0 12px 32px 4px rgba(0, 0, 0, 0.04), 0 8px 20px rgba(0, 0, 0, 0.08);
        display: none;
        transition: all 0.2s ease;
        scrollbar-width: thin;
        scrollbar-color: #dcdfe6 transparent;
    `;

  statusOptions.innerHTML += `
        <style>
            .select-options::-webkit-scrollbar {
                width: 6px;
            }
            .select-options::-webkit-scrollbar-track {
                background: #f1f5f9;
                border-radius: 10px;
            }
            .select-options::-webkit-scrollbar-thumb {
                background: #cbd5e1;
                border-radius: 10px;
            }
            .select-options::-webkit-scrollbar-thumb:hover {
                background: #94a3b8;
            }
        </style>
    `;

  const statusOptionsList = [
    { value: "不限", text: "不限" },
    { value: "在线", text: "在线" },
    { value: "刚刚活跃", text: "刚刚活跃" },
    { value: "今日活跃", text: "今日活跃" },
    { value: "3日内活跃", text: "3日内活跃" },
    { value: "本周活跃", text: "本周活跃" },
    { value: "本月活跃", text: "本月活跃" },
    { value: "半年前活跃", text: "半年前活跃" },
  ];

  statusOptionsList.forEach((option) => {
    const isSelected =
      settings.recruiterActivityStatus &&
      Array.isArray(settings.recruiterActivityStatus) &&
      settings.recruiterActivityStatus.includes(option.value);
    const statusOption = document.createElement("div");
    statusOption.className = "select-option" + (isSelected ? " selected" : "");
    statusOption.dataset.value = option.value;
    statusOption.style.cssText = `
            height: 34px;
            padding: 0 20px;
            cursor: pointer;
            transition: all 0.2s ease;
            display: flex;
            align-items: center;
            font-size: 14px;
            color: ${isSelected ? "#1a73e8" : "#606266"};
            font-weight: ${isSelected ? "600" : "400"};
        `;

    const textSpan = document.createElement("span");
    textSpan.textContent = option.text;
    textSpan.style.flex = "1";

    const checkIcon = document.createElement("span");
    checkIcon.className = "check-icon";
    checkIcon.innerHTML = "✓";
    checkIcon.style.cssText = `
            margin-left: auto;
            color: #1a73e8;
            font-weight: bold;
            display: ${isSelected ? "inline" : "none"};
        `;

    statusOption.append(textSpan, checkIcon);

    statusOption.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleStatusOption(option.value);
    });

    statusOptions.appendChild(statusOption);
  });

  statusHeader.addEventListener("click", () => {
    const open = statusOptions.style.display !== "block";
    statusOptions.style.display = open ? "block" : "none";
    statusIcon.style.transform = open ? "rotate(180deg)" : "rotate(0)";
    statusHeader.style.borderColor = open ? "#1a73e8" : "#dcdfe6";
  });

  document.addEventListener("click", (e) => {
    if (!statusSelect.contains(e.target)) {
      statusOptions.style.display = "none";
      statusIcon.style.transform = "rotate(0)";
      statusHeader.style.borderColor = "#dcdfe6";
    }
  });

  statusHeader.addEventListener("mouseenter", () => {
    if (statusOptions.style.display !== "block") statusHeader.style.borderColor = "#c0c4cc";
  });

  statusHeader.addEventListener("mouseleave", () => {
    if (statusOptions.style.display !== "block") statusHeader.style.borderColor = "#dcdfe6";
  });

  statusSelect.append(statusHeader, statusOptions);
  recruiterStatusSetting.append(statusSelect);

  // —— v2.1.0 新增：投递节奏与安全上限 ——
  const paceSettingResult = createSettingItem(
    "投递节奏 (毫秒)",
    "每投递一个岗位之间的间隔，建议 2000-5000，过小容易触发风控",
    () => document.getElementById("apply-interval-input"),
  );
  const paceSetting = paceSettingResult.settingItem;
  const paceInput = document.createElement("input");
  paceInput.id = "apply-interval-input";
  paceInput.type = "number";
  paceInput.min = "800";
  paceInput.step = "100";
  paceInput.value = settings.applyInterval;
  paceInput.style.cssText =
    "width:100%;padding:9px 14px;border-radius:6px;border:1px solid transparent;background:#f1f3f4;font-size:13px;margin-top:12px;box-sizing:border-box;outline:none;transition:all 0.2s;";
  addFocusBlurEffects(paceInput);
  paceSetting.append(paceInput);

  const limitSettingResult = createSettingItem(
    "单次投递上限",
    "一次运行最多投递多少个岗位，默认 50，避免投递过多",
    () => document.getElementById("max-apply-input"),
  );
  const limitSetting = limitSettingResult.settingItem;
  const limitInput = document.createElement("input");
  limitInput.id = "max-apply-input";
  limitInput.type = "number";
  limitInput.min = "1";
  limitInput.step = "1";
  limitInput.value = settings.maxApplyPerRun;
  limitInput.style.cssText =
    "width:100%;padding:9px 14px;border-radius:6px;border:1px solid transparent;background:#f1f3f4;font-size:13px;margin-top:12px;box-sizing:border-box;outline:none;transition:all 0.2s;";
  addFocusBlurEffects(limitInput);
  limitSetting.append(limitInput);

  const jobGroup = createSettingsGroup("投递基础设置");
  jobGroup.card.append(
    recruiterStatusSetting,
    excludeHeadhuntersSetting,
    paceSetting,
    limitSetting,
  );
  jobSettingsPanel.append(jobGroup.group);

  // 聊天相关：打招呼、简历、其他各归一张卡片
  const greetingGroup = createSettingsGroup("打招呼设置");
  greetingGroup.card.append(greetingsSetting);

  const resumeGroup = createSettingsGroup("简历发送设置");
  resumeGroup.card.append(autoSendResumeSetting, imageResumeSetting);

  const chatOtherGroup = createSettingsGroup("其他");
  chatOtherGroup.card.append(autoAcceptCardSetting);

  chatSettingsPanel.append(greetingGroup.group, resumeGroup.group, chatOtherGroup.group);

  // 底栏只放两个按钮，高度压到最小 —— 旧版 15px 内边距 + 9px 按钮内边距，一条空条占掉
  // 近 70px，而弹窗总高只有 80vh
  const dialogFooter = document.createElement("div");
  dialogFooter.style.cssText = `
        padding: 8px 16px;
        border-top: 1px solid #e5e7eb;
        display: flex;
        justify-content: flex-end;
        gap: 10px;
        background: rgba(0, 0, 0, 0.03);
        flex-shrink: 0;
    `;

  const cancelBtn = createSettingsButton("取消", "neutral", () => {
    closeSettingsDialog();
  });

  const saveBtn = createSettingsButton("保存设置", "primary", () => {
    try {
      // 收集所有输入框的值再统一落盘（v2.1.0：不再只保存一部分字段）
      const val = (id) => {
        const el = document.getElementById(id);
        return el ? el.value : undefined;
      };

      const apiUrl = val("ai-api-url-input");
      if (apiUrl !== undefined) settings.aiApiUrl = apiUrl.trim();

      const apiKey = val("ai-api-key-input");
      if (apiKey !== undefined) settings.aiApiKey = apiKey.trim();

      const model = val("ai-model-input");
      if (model !== undefined) settings.aiModel = model.trim() || "deepseek-chat";

      const template = val("prompt-template-input");
      if (template !== undefined) settings.promptTemplate = template;

      const intervalEl = val("apply-interval-input");
      if (intervalEl !== undefined && intervalEl !== "") {
        const n = parseInt(intervalEl, 10);
        if (!isNaN(n) && n >= 800) settings.applyInterval = n;
      }
      const maxEl = val("max-apply-input");
      if (maxEl !== undefined && maxEl !== "") {
        const n = parseInt(maxEl, 10);
        if (!isNaN(n) && n > 0) settings.maxApplyPerRun = n;
      }

      saveSettings();
      refreshPanelModeUI();
      showNotification("设置已保存");
      closeSettingsDialog();
    } catch (error) {
      showNotification("保存失败: " + error.message, "error");
      console.error("[BOSS投递助手] 保存设置失败:", error);
    }
  });

  dialogFooter.append(cancelBtn, saveBtn);

  dialogContent.append(generalSettingsPanel, jobSettingsPanel, chatSettingsPanel);
  dialog.append(dialogHeader, dialogContent, dialogFooter);

  // —— 提示词编辑器：盖在设置弹窗内部的小模态框 ——
  const promptEditorStyle = document.createElement("style");
  promptEditorStyle.textContent = `
    #prompt-editor-overlay {
      position: absolute; inset: 0; z-index: 30;
      display: none; justify-content: center; align-items: center;
      background: rgba(32, 33, 36, 0.6);
      opacity: 0; visibility: hidden;
      transition: opacity 0.2s ease, visibility 0.2s ease;
    }
    #prompt-editor-overlay.show { opacity: 1; visibility: visible; }
    #prompt-editor-overlay .prompt-editor-modal {
      transform: translateY(20px);
      transition: transform 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
    }
    #prompt-editor-overlay.show .prompt-editor-modal { transform: translateY(0); }
  `;

  const promptOverlay = document.createElement("div");
  promptOverlay.id = "prompt-editor-overlay";

  const promptModal = document.createElement("div");
  promptModal.className = "prompt-editor-modal";
  promptModal.style.cssText =
    "width:calc(100% - 48px);max-width:560px;max-height:calc(100% - 48px);overflow-y:auto;background:#fff;border-radius:8px;padding:24px 32px 32px;box-shadow:0 10px 25px rgba(0,0,0,0.2);box-sizing:border-box;";

  const promptTitle = document.createElement("h2");
  promptTitle.textContent = "编辑提示词";
  promptTitle.style.cssText = "margin:0 0 16px;font-size:20px;font-weight:400;color:#202124;";

  const promptInput = document.createElement("textarea");
  promptInput.id = "prompt-template-input";
  promptInput.placeholder = "请在此输入或修改您的提示词...";
  promptInput.style.cssText =
    "width:100%;min-height:200px;height:min(320px, 42vh);padding:16px;background:#f1f3f4;border:none;border-bottom:2px solid transparent;border-radius:4px;font-size:14px;line-height:1.6;color:#202124;outline:none;resize:none;box-sizing:border-box;transition:border-color 0.2s ease;";
  promptInput.addEventListener("focus", () => {
    promptInput.style.borderBottomColor = "#1a73e8";
  });
  promptInput.addEventListener("blur", () => {
    promptInput.style.borderBottomColor = "transparent";
  });

  const promptFooter = document.createElement("div");
  promptFooter.style.cssText = "display:flex;justify-content:flex-end;gap:12px;margin-top:24px;";

  const promptCancelBtn = createSettingsButton("取消", "neutral");
  promptCancelBtn.id = "prompt-editor-cancel";

  const promptSaveBtn = createSettingsButton("保存", "primary");
  promptSaveBtn.id = "prompt-editor-save";

  promptFooter.append(promptCancelBtn, promptSaveBtn);
  promptModal.append(promptTitle, promptInput, promptFooter);
  promptOverlay.appendChild(promptModal);
  dialog.append(promptEditorStyle, promptOverlay);

  const openPromptEditor = () => {
    promptInput.value = settings.promptTemplate || PROMPT_TEMPLATE_DEFAULT;
    promptOverlay.style.display = "flex";
    requestAnimationFrame(() => promptOverlay.classList.add("show"));
    setTimeout(() => {
      promptInput.focus();
      promptInput.setSelectionRange(0, 0);
      promptInput.scrollTop = 0;
    }, 50);
  };

  const closePromptEditor = (revert = false) => {
    if (revert) promptInput.value = settings.promptTemplate || PROMPT_TEMPLATE_DEFAULT;
    promptOverlay.classList.remove("show");
    promptOverlay.style.display = "none";
  };

  editPromptBtn.addEventListener("click", openPromptEditor);
  promptCancelBtn.addEventListener("click", () => closePromptEditor(true));
  promptSaveBtn.addEventListener("click", () => {
    const value = promptInput.value;
    if (!value.trim()) {
      showNotification("请输入提示词内容", "error");
      promptInput.focus();
      return;
    }
    settings.promptTemplate = value;
    saveSettings();
    showNotification("提示词已保存");
    closePromptEditor();
  });
  promptOverlay.addEventListener("click", (e) => {
    if (e.target === promptOverlay) closePromptEditor(true);
  });

  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) {
      closeSettingsDialog();
    }
  });

  return dialog;
}

/* ---------- 弹窗与面板互斥：两者不同时出现在页面上 ---------- */

/** 打开弹窗前，面板原来的 transform（关闭时原样还回去） */
let panelTransformBeforeDialog = null;

/**
 * 把投递面板收到屏幕外。
 *
 * 不用 `display: none`：面板的日志区一直在被 Core 写入，而且导出日志、面板守护都
 * 依赖它仍然"在渲染中"（隐藏后 `innerText` 会读成空字符串）。
 * 位移样式与「最小化」共用，所以是两个动作、一种表现。
 */
function hidePanelForDialog() {
  if (!elements.panel) return;
  panelTransformBeforeDialog = elements.panel.style.transform || "";
  elements.panel.style.transform = CONFIG.UI.PANEL_HIDDEN_TRANSFORM;
}

/** 关弹窗时把面板还原（连"本来就最小化着"这种情况也一并还原） */
function restorePanelAfterDialog() {
  if (!elements.panel || panelTransformBeforeDialog === null) return;
  elements.panel.style.transform = panelTransformBeforeDialog;
  panelTransformBeforeDialog = null;
}

/** 关闭设置弹窗。所有关闭入口（✕ / 取消 / 保存 / 点遮罩）都走这里 */
export function closeSettingsDialog() {
  const dialog = document.getElementById("boss-settings-dialog");
  if (dialog) {
    dialog.style.display = "none";
    const promptOverlay = document.getElementById("prompt-editor-overlay");
    if (promptOverlay) {
      promptOverlay.classList.remove("show");
      promptOverlay.style.display = "none";
    }
  }
  restorePanelAfterDialog();
}

export function showSettingsDialog() {
  let dialog = document.getElementById("boss-settings-dialog");
  if (!dialog) {
    dialog = createSettingsDialog();
    document.body.appendChild(dialog);
  }

  // 面板 z-index 比弹窗还高，两个都开着的话面板会压在弹窗头上
  hidePanelForDialog();

  dialog.style.display = "flex";

  setTimeout(() => {
    dialog.classList.add("active");
    setTimeout(loadSettingsIntoUI, 100);
  }, 10);
}

export function toggleStatusOption(value) {
  if (value === "不限") {
    // 「不限」是筛选兜底项，不允许取消到空数组：
    // 空数组既不代表"全部"，也会让 processOneJob 把所有岗位都跳过。
    settings.recruiterActivityStatus = ["不限"];
  } else {
    if (settings.recruiterActivityStatus.includes("不限")) {
      settings.recruiterActivityStatus = [value];
    } else {
      if (settings.recruiterActivityStatus.includes(value)) {
        settings.recruiterActivityStatus = settings.recruiterActivityStatus.filter(
          (v) => v !== value,
        );
      } else {
        settings.recruiterActivityStatus.push(value);
      }

      if (settings.recruiterActivityStatus.length === 0) {
        settings.recruiterActivityStatus = ["不限"];
      }
    }
  }

  if (state.settings) {
    state.settings.recruiterActivityStatus = settings.recruiterActivityStatus;
  }

  updateStatusOptions();
}

export function updateStatusOptions() {
  const options = document.querySelectorAll("#recruiter-status-select .select-option");
  options.forEach((option) => {
    const isSelected = settings.recruiterActivityStatus.includes(option.dataset.value);
    option.className = "select-option" + (isSelected ? " selected" : "");
    option.querySelector(".check-icon").style.display = isSelected ? "inline" : "none";

    if (option.dataset.value === "不限") {
      if (isSelected) {
        options.forEach((opt) => {
          if (opt.dataset.value !== "不限") {
            opt.className = "select-option";
            opt.querySelector(".check-icon").style.display = "none";
          }
        });
      }
    } else if (settings.recruiterActivityStatus.includes("不限")) {
      option.querySelector(".check-icon").style.display = "none";
      option.className = "select-option";
    }
  });

  // 选中项蓝字加粗 + 右侧对勾，未选中灰字
  options.forEach((option) => {
    const selected = option.classList.contains("selected");
    option.style.color = selected ? "#1a73e8" : "#606266";
    option.style.fontWeight = selected ? "600" : "400";
  });

  document.querySelector("#recruiter-status-select .select-value").textContent =
    getStatusDisplayText();

  if (state.settings) {
    state.settings.recruiterActivityStatus = settings.recruiterActivityStatus;
  }
}

export function getStatusDisplayText() {
  if (settings.recruiterActivityStatus.includes("不限")) {
    return "不限";
  }

  if (settings.recruiterActivityStatus.length === 0) {
    return "不限";
  }

  if (settings.recruiterActivityStatus.length <= 3) {
    return settings.recruiterActivityStatus.join("、");
  }

  return `${settings.recruiterActivityStatus.slice(0, 3).join("、")} 等 ${settings.recruiterActivityStatus.length} 项`;
}

/**
 * 把配置回填到设置弹窗的各个控件。
 * v2.1.0 修复点：旧版这里没有回填「API 地址 / API Key / 模型 / 个人简历 / 招呼语模板」，
 * 用户打开弹窗看到空白输入框，点保存就把已保存的值覆盖成空 —— 表现为"刷新后配置全没了"。
 */
export function loadSettingsIntoUI() {
  // —— API 配置（旧版缺失）——
  const apiUrlInput = document.getElementById("ai-api-url-input");
  if (apiUrlInput) apiUrlInput.value = settings.aiApiUrl || "";
  const apiKeyInput = document.getElementById("ai-api-key-input");
  if (apiKeyInput) apiKeyInput.value = settings.aiApiKey || "";
  const modelInput = document.getElementById("ai-model-input");
  if (modelInput) modelInput.value = settings.aiModel || "";

  // —— 提示词页 ——
  const templateInput = document.getElementById("prompt-template-input");
  if (templateInput) templateInput.value = settings.promptTemplate || PROMPT_TEMPLATE_DEFAULT;

  // —— 开关（同步 checked 与滑块视觉状态）——
  syncToggle("auto-send-resume", settings.useAutoSendResume);
  syncToggle("exclude-headhunters", settings.excludeHeadhunters);
  syncToggle(
    "auto-send-image-resume",
    !!(
      settings.useAutoSendImageResume &&
      settings.imageResumes &&
      settings.imageResumes.length > 0
    ),
  );

  // —— 沟通页设置 ——
  // 沟通模式在面板上是两个 radio，不是 select；回填时按保存的模式勾选
  const modeNew = document.getElementById("communication-mode-new");
  const modeAuto = document.getElementById("communication-mode-auto");
  if (modeNew && modeAuto) {
    const isAuto = settings.communicationMode === "auto";
    modeNew.checked = !isAuto;
    modeAuto.checked = isAuto;
  }

  // —— 节奏 ——
  const applyIntervalInput = document.getElementById("apply-interval-input");
  if (applyIntervalInput) applyIntervalInput.value = settings.applyInterval;
  const maxApplyInput = document.getElementById("max-apply-input");
  if (maxApplyInput) maxApplyInput.value = settings.maxApplyPerRun;

  // —— 打招呼列表 ——
  loadGreetings();

  // —— 招聘者活跃状态 ——
  updateStatusOptions();

  // —— 图片简历数量 ——
  refreshImageResumeCount();
}

/** 同步开关的勾选状态与滑块位置 */
export function syncToggle(id, checked) {
  const input = document.getElementById("toggle-" + id);
  if (!input) return;
  input.checked = !!checked;
  const container = input.closest(".toggle-switch");
  if (!container) return;
  const slider = container.querySelector(".toggle-slider");
  container.style.backgroundColor = checked ? "#1a73e8" : "#e4e7ed";
  if (slider) slider.style.left = checked ? "19px" : "3px";
}

/** 刷新"已上传 N 个简历"文案 */
export function refreshImageResumeCount() {
  const display = document.getElementById("image-resume-filename");
  if (!display) return;
  const count = (settings.imageResumes && settings.imageResumes.length) || 0;
  display.textContent = count > 0 ? `已上传 ${count} 个简历` : "未选择文件";
}

/**
 * 弹窗标题栏。
 *
 * `tabs` 是可选的：传进来就摆在标题右边（三个设置页的切换按钮），
 * 不传就是「标题 —— 关闭」的普通标题栏。
 * `onClose` 也是可选的，给了就由它负责关闭（设置弹窗要顺带还原投递面板）。
 */
export function createDialogHeader(
  title,
  dialogId = "boss-settings-dialog",
  tabs = null,
  onClose = null,
) {
  const header = document.createElement("div");
  header.className = "boss-dialog-header";
  header.style.cssText = `
        padding: 12px 18px;
        background: #ffffff;
        color: #202124;
        font-size: 17px;
        font-weight: 600;
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
        position: relative;
        border-radius: 12px 12px 0 0;
        border-bottom: 1px solid #e5e9f2;
        flex-shrink: 0;
    `;

  const titleElement = document.createElement("div");
  titleElement.textContent = title;
  titleElement.style.cssText = "font-weight: 600; white-space: nowrap;";

  const closeBtn = document.createElement("button");
  closeBtn.innerHTML = "✕";
  closeBtn.title = "关闭";
  closeBtn.style.cssText = `
        width: 28px;
        height: 28px;
        background: #e8f0fe;
        color: #1a73e8;
        border-radius: 50%;
        display: flex;
        justify-content: center;
        align-items: center;
        cursor: pointer;
        transition: all 0.2s ease;
        border: none;
        font-size: 16px;
        font-weight: bold;
    `;

  closeBtn.addEventListener("mouseenter", () => {
    closeBtn.style.backgroundColor = "#1a73e8";
    closeBtn.style.color = "#ffffff";
    closeBtn.style.transform = "scale(1.1)";
  });

  closeBtn.addEventListener("mouseleave", () => {
    closeBtn.style.backgroundColor = "#e8f0fe";
    closeBtn.style.color = "#1a73e8";
    closeBtn.style.transform = "scale(1)";
  });

  closeBtn.addEventListener("click", () => {
    if (onClose) {
      onClose();
      return;
    }
    const dialog = document.getElementById(dialogId);
    if (dialog) {
      dialog.style.display = "none";
    }
  });

  const leftGroup = document.createElement("div");
  leftGroup.style.cssText = "display:flex;align-items:center;gap:14px;min-width:0;";
  leftGroup.append(titleElement);
  if (tabs) leftGroup.append(tabs);

  header.append(leftGroup, closeBtn);
  return header;
}

/**
 * 设置分组：标题在卡片外，卡片里是一组同类设置行。
 * 行与行之间用细分隔线，最后一行由 `.settings-card .setting-item:last-child` 去掉。
 */
export function createSettingsGroup(title) {
  const group = document.createElement("div");
  group.className = "settings-group";
  group.style.marginBottom = "24px";

  const heading = document.createElement("h3");
  heading.textContent = title;
  heading.style.cssText = `
        margin: 0 0 12px;
        padding-left: 4px;
        color: #202124;
        font-size: 14px;
        font-weight: 500;
    `;

  const card = document.createElement("div");
  card.className = "settings-card";
  card.style.cssText = `
        background: #fff;
        border-radius: 12px;
        border: 1px solid #e5e9f2;
        padding: 0 20px;
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.02);
    `;

  group.append(heading, card);
  return { group, card };
}

export function createSettingItem(title, description, controlGetter) {
  const settingItem = document.createElement("div");
  settingItem.className = "setting-item";
  settingItem.style.cssText = `
        padding: 10px 0;
        border-bottom: 1px solid #f1f3f4;
        display: flex;
        flex-direction: column;
    `;

  const titleElement = document.createElement("h4");
  titleElement.textContent = title;
  titleElement.style.cssText = `
        margin: 0 0 4px;
        color: #202124;
        font-size: 14px;
        font-weight: 500;
    `;

  const descElement = document.createElement("p");
  descElement.textContent = description;
  descElement.style.cssText = `
        margin: 0;
        color: #5f6368;
        font-size: 12px;
        line-height: 1.5;
    `;

  const descriptionContainer = document.createElement("div");
  descriptionContainer.style.cssText = `
        display: flex;
        justify-content: space-between;
        align-items: center;
        width: 100%;
    `;

  const textContainer = document.createElement("div");
  textContainer.append(titleElement, descElement);

  descriptionContainer.append(textContainer);

  settingItem.append(descriptionContainer);

  settingItem.addEventListener("click", (e) => {
    // 点在本就自己吃焦点的控件上时别再抢一次：不挡这一下的话，点进第二个控件会立刻
    // 被弹回第一个控件，长文本根本没法编辑
    if (e.target && e.target.closest && e.target.closest("input, textarea, select, button")) return;
    const control = controlGetter();
    if (control && typeof control.focus === "function") {
      control.focus();
    }
  });

  return {
    settingItem,
    descriptionContainer,
  };
}

export function createToggleSwitch(id, isChecked, onChange) {
  const container = document.createElement("div");
  container.className = "toggle-container";
  container.style.cssText = "display: flex; justify-content: space-between; align-items: center;";

  const switchContainer = document.createElement("div");
  switchContainer.className = "toggle-switch";

  switchContainer.style.cssText = `
        position: relative;
        width: 38px;
        height: 22px;
        border-radius: 22px;
        background-color: ${isChecked ? "#1a73e8" : "#e4e7ed"};
        cursor: pointer;
        opacity: 1;
        flex-shrink: 0;
    `;

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.id = `toggle-${id}`;
  checkbox.checked = isChecked;
  checkbox.style.display = "none";

  const slider = document.createElement("span");
  slider.className = "toggle-slider";
  slider.style.cssText = `
        position: absolute;
        top: 3px;
        left: ${isChecked ? "19px" : "3px"};
        width: 16px;
        height: 16px;
        border-radius: 50%;
        background-color: white;
        box-shadow: 0 1px 3px rgba(0,0,0,0.2);
        transition: none;
    `;

  const forceUpdateUI = (checked) => {
    checkbox.checked = checked;
    switchContainer.style.backgroundColor = checked ? "#1a73e8" : "#e4e7ed";
    slider.style.left = checked ? "19px" : "3px";
  };

  checkbox.addEventListener("change", () => {
    let allowChange = true;

    if (onChange) {
      allowChange = onChange(checkbox.checked) !== false;
    }

    if (!allowChange) {
      forceUpdateUI(!checkbox.checked);
      return;
    }

    forceUpdateUI(checkbox.checked);
  });

  switchContainer.addEventListener("click", () => {
    const newState = !checkbox.checked;

    if (onChange) {
      if (onChange(newState) !== false) {
        forceUpdateUI(newState);
      }
    } else {
      forceUpdateUI(newState);
    }
  });

  switchContainer.append(checkbox, slider);
  container.append(switchContainer);

  return container;
}

/**
 * 设置页统一的文字按钮：高度 32px、圆角 4px、字号 14px。
 * variant: primary（蓝色实底）/ secondary（浅蓝）/ neutral（白底灰边）/ danger（红边）。
 */
export function createSettingsButton(text, variant = "primary", onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = text;
  button.className = `settings-btn settings-btn-${variant}`;
  if (onClick) button.addEventListener("click", onClick);
  return button;
}

export function addFocusBlurEffects(element) {
  element.addEventListener("focus", () => {
    element.style.borderColor = "rgba(26, 115, 232, 0.7)";
    element.style.boxShadow = "0 0 0 3px rgba(26, 115, 232, 0.2)";
  });

  element.addEventListener("blur", () => {
    element.style.borderColor = "#d1d5db";
    element.style.boxShadow = "none";
  });
}

/**
 * v2.1.0：面板挂到 document 之后统一同步一次按钮文案（旧版在元素还游离在内存里时
 * 就调用，导致取不到节点、状态永远不刷新）。
 * v2.2.0 起面板上不再有 AI 开关和预览框，只剩「运行中不要覆盖按钮」这一条约束。
 */
export function refreshPanelModeUI() {
  try {
    if (elements.controlBtn && !state.isRunning) {
      // 两个页面的按钮文案不同：以前这里无条件写「启动投递」，
      // 于是聊天页新建面板后，按钮从「开始聊天」被改成了「启动投递」
      const isChat = PAGE.isChat();
      elements.controlBtn.textContent = isChat ? "开始聊天" : "开始投递";
      elements.controlBtn.style.background = "var(--primary-color)";
    }
  } catch (e) {
    console.error("[BOSS投递助手] 刷新面板 UI 失败:", e);
  }
}

/** v2.1.0：刷新面板底部的运行统计 */
export function refreshStatsUI() {
  const map = {
    "stat-greeted": state.stats.greeted,
    "stat-skipped": state.stats.skipped,
    "stat-failed": state.stats.failed,
  };
  Object.keys(map).forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.textContent = String(map[id]);
  });
}

export function resetStats() {
  state.stats.greeted = 0;
  state.stats.skipped = 0;
  state.stats.failed = 0;
  state.stats.startTime = Date.now();
  refreshStatsUI();
}

export function showNotification(message, type = "success") {
  const notification = document.createElement("div");
  const isSuccess = type === "success";
  const background = isSuccess ? "rgba(232, 240, 254, 0.92)" : "rgba(252, 232, 230, 0.94)";
  const color = isSuccess ? "#1a73e8" : "#d93025";
  const border = isSuccess ? "rgba(26, 115, 232, 0.25)" : "rgba(217, 48, 37, 0.25)";

  notification.style.cssText = `
        position: fixed;
        top: 20px;
        left: 50%;
        transform: translateX(-50%);
        background: ${background};
        color: ${color};
        border: 1px solid ${border};
        padding: 10px 15px;
        border-radius: 8px;
        box-shadow: 0 4px 14px rgba(26, 115, 232, 0.16);
        backdrop-filter: blur(6px);
        z-index: 9999999;
        opacity: 0;
        transition: opacity 0.3s ease;
    `;

  notification.textContent = message;
  document.body.appendChild(notification);

  setTimeout(() => (notification.style.opacity = "1"), 10);
  setTimeout(() => {
    notification.style.opacity = "0";
    setTimeout(() => document.body.removeChild(notification), 300);
  }, 2000);
}
