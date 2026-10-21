export const guide = {
  steps: [
    {
      target: "div.city-label.active",
      content:
        '投递前，先在BOSS<span class="highlight">筛选出岗位</span>！\n\n助手会先滚动收集界面上显示的岗位，\n再逐个打开、交给 AI 判断是否投递~',

      arrowPosition: "bottom",
      defaultPosition: {
        left: "50%",
        top: "20%",
        transform: "translateX(-50%)",
      },
    },
    {
      target: 'a[ka="header-jobs"]',
      content:
        '<span class="highlight">职位页操作流程</span>：\n\n1. 滚动收集职位卡片\n2. 逐个打开详情，AI 对照简历与投递要求判断\n3. 判定通过才点"立即沟通"（需开启"自动打招呼"）\n\n全程无需手动干预，高效投递！',

      arrowPosition: "bottom",
      defaultPosition: { left: "25%", top: "80px" },
    },
    {
      target: 'a[ka="header-message"]',
      content:
        '<span class="highlight">投递建议</span>！\n\n• HR与您沟通，HR需要付费给平台\n因此您尽可能先自我介绍以提高效率 \n\n• HR查看附件简历，HR也要付费给平台\n所以尽量先发送`图片简历`给HR',

      arrowPosition: "left",
      defaultPosition: { right: "150px", top: "100px" },
    },
    {
      target: "div.logo",
      content:
        '<span class="highlight">您需要打开两个浏览器窗口</span>：\n\n左侧窗口自动打招呼发起沟通\n右侧发送自我介绍和图片简历\n\n您只需专注于挑选offer！',

      arrowPosition: "right",
      defaultPosition: { left: "200px", top: "20px" },
    },
    {
      target: "div.logo",
      content:
        '<span class="highlight">特别注意</span>：\n\n1. <span class="warning">BOSS直聘每日打招呼上限为150次</span>\n2. 聊天页仅处理最上方的最新对话\n3. 打招呼后对方会显示在聊天页\n4. <span class="warning">投递操作过于频繁有封号风险!</span>',

      arrowPosition: "bottom",
      defaultPosition: { left: "50px", top: "80px" },
    },
  ],
  currentStep: 0,
  guideElement: null,
  overlay: null,
  highlightElements: [],

  showGuideToUser() {
    this.overlay = document.createElement("div");
    this.overlay.id = "guide-overlay";
    this.overlay.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.5);
            backdrop-filter: blur(2px);
            z-index: 99997;
            pointer-events: none;
            opacity: 0;
            transition: opacity 0.3s ease;
        `;
    document.body.appendChild(this.overlay);

    this.guideElement = document.createElement("div");
    this.guideElement.id = "guide-tooltip";
    this.guideElement.style.cssText = `
            position: fixed;
            z-index: 99999;
            width: 320px;
            background: white;
            border-radius: 12px;
            box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04);
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            overflow: hidden;
            opacity: 0;
            transform: translateY(10px);
            transition: opacity 0.3s ease, transform 0.3s ease;
        `;
    document.body.appendChild(this.guideElement);

    setTimeout(() => {
      this.overlay.style.opacity = "1";

      setTimeout(() => {
        this.showStep(0);
      }, 300);
    }, 100);
  },

  showStep(stepIndex) {
    const step = this.steps[stepIndex];
    if (!step) return;

    this.clearHighlights();
    const target = document.querySelector(step.target);

    if (target) {
      const rect = target.getBoundingClientRect();
      const highlight = document.createElement("div");
      highlight.className = "guide-highlight";
      highlight.style.cssText = `
                position: fixed;
                top: ${rect.top}px;
                left: ${rect.left}px;
                width: ${rect.width}px;
                height: ${rect.height}px;
                background: ${step.highlightColor || "#1a73e8"};
                opacity: 0.2;
                border-radius: 4px;
                z-index: 99998;
                box-shadow: 0 0 0 4px ${step.highlightColor || "#1a73e8"};
                animation: guide-pulse 2s infinite;
            `;
      document.body.appendChild(highlight);
      this.highlightElements.push(highlight);

      this.setGuidePositionFromTarget(step, rect);
    } else {
      console.warn("引导目标元素未找到，使用默认位置:", step.target);

      this.setGuidePositionFromDefault(step);
    }

    let buttonsHtml = "";

    if (stepIndex === this.steps.length - 1) {
      buttonsHtml = `
                <div class="guide-buttons" style="display: flex; justify-content: center; padding: 16px; border-top: 1px solid #f0f0f0; background: #f9fafb;">
                    <button id="guide-finish-btn" style="padding: 8px 32px; background: ${
                      step.highlightColor || "#1a73e8"
                    }; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 500; transition: all 0.2s ease; box-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.06);">
                        完成
                    </button>
                </div>
            `;
    } else {
      buttonsHtml = `
                <div class="guide-buttons" style="display: flex; justify-content: flex-end; padding: 16px; border-top: 1px solid #f0f0f0; background: #f9fafb;">
                    <button id="guide-skip-btn" style="padding: 8px 16px; background: white; color: #4b5563; border: 1px solid #e5e7eb; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 500; transition: all 0.2s ease;">跳过</button>
                    <button id="guide-next-btn" style="padding: 8px 16px; background: ${
                      step.highlightColor || "#1a73e8"
                    }; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 500; margin-left: 8px; transition: all 0.2s ease; box-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.06);">下一步</button>
                </div>
            `;
    }

    this.guideElement.innerHTML = `
            <div class="guide-header" style="padding: 16px; background: ${
              step.highlightColor || "#1a73e8"
            }; color: white;">
                <div class="guide-title" style="font-size: 16px; font-weight: 600;">BOSS投递助手引导</div>
                <div class="guide-step" style="font-size: 12px; opacity: 0.8; margin-top: 2px;">步骤 ${
                  stepIndex + 1
                }/${this.steps.length}</div>
            </div>
            <div class="guide-content" style="padding: 20px; font-size: 14px; line-height: 1.6;">
                <div style="white-space: pre-wrap; font-family: inherit; margin: 0;">${
                  step.content
                }</div>
            </div>
            ${buttonsHtml}
        `;

    if (stepIndex === this.steps.length - 1) {
      document
        .getElementById("guide-finish-btn")
        .addEventListener("click", () => this.endGuide(true));
    } else {
      document.getElementById("guide-next-btn").addEventListener("click", () => this.nextStep());
      document.getElementById("guide-skip-btn").addEventListener("click", () => this.endGuide());
    }

    if (stepIndex === this.steps.length - 1) {
      const finishBtn = document.getElementById("guide-finish-btn");
      finishBtn.addEventListener("mouseenter", () => {
        finishBtn.style.background = this.darkenColor(step.highlightColor || "#1a73e8", 15);
        finishBtn.style.boxShadow =
          "0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)";
      });
      finishBtn.addEventListener("mouseleave", () => {
        finishBtn.style.background = step.highlightColor || "#1a73e8";
        finishBtn.style.boxShadow =
          "0 1px 3px 0 rgba(0, 0, 0, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.06)";
      });
    } else {
      const nextBtn = document.getElementById("guide-next-btn");
      const skipBtn = document.getElementById("guide-skip-btn");

      nextBtn.addEventListener("mouseenter", () => {
        nextBtn.style.background = this.darkenColor(step.highlightColor || "#1a73e8", 15);
        nextBtn.style.boxShadow =
          "0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)";
      });
      nextBtn.addEventListener("mouseleave", () => {
        nextBtn.style.background = step.highlightColor || "#1a73e8";
        nextBtn.style.boxShadow = "0 1px 3px 0 rgba(0, 0, 0, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.06)";
      });

      skipBtn.addEventListener("mouseenter", () => {
        skipBtn.style.background = "#f3f4f6";
      });
      skipBtn.addEventListener("mouseleave", () => {
        skipBtn.style.background = "white";
      });
    }

    this.guideElement.style.opacity = "1";
    this.guideElement.style.transform = "translateY(0)";
  },

  setGuidePositionFromTarget(step, rect) {
    let left, top;
    const guideWidth = 320;
    const guideHeight = 240;

    switch (step.arrowPosition) {
      case "top":
        left = rect.left + rect.width / 2 - guideWidth / 2;
        top = rect.top - guideHeight - 20;
        break;
      case "bottom":
        left = rect.left + rect.width / 2 - guideWidth / 2;
        top = rect.bottom + 20;
        break;
      case "left":
        left = rect.left - guideWidth - 20;
        top = rect.top + rect.height / 2 - guideHeight / 2;
        break;
      case "right":
        left = rect.right + 20;
        top = rect.top + rect.height / 2 - guideHeight / 2;
        break;
      default:
        left = rect.right + 20;
        top = rect.top;
    }

    left = Math.max(10, Math.min(left, window.innerWidth - guideWidth - 10));
    top = Math.max(10, Math.min(top, window.innerHeight - guideHeight - 10));

    this.guideElement.style.left = `${left}px`;
    this.guideElement.style.top = `${top}px`;
    this.guideElement.style.transform = "translateY(0)";
  },

  setGuidePositionFromDefault(step) {
    const position = step.defaultPosition || {
      left: "50%",
      top: "50%",
      transform: "translate(-50%, -50%)",
    };

    Object.assign(this.guideElement.style, {
      left: position.left,
      top: position.top,
      right: position.right || "auto",
      bottom: position.bottom || "auto",
      transform: position.transform || "none",
    });
  },

  nextStep() {
    const currentStep = this.steps[this.currentStep];
    if (currentStep) {
      const target = document.querySelector(currentStep.target);
      if (target) {
        target.removeEventListener("click", this.nextStep);
      }
    }

    this.currentStep++;
    if (this.currentStep < this.steps.length) {
      this.guideElement.style.opacity = "0";
      this.guideElement.style.transform = "translateY(10px)";

      setTimeout(() => {
        this.showStep(this.currentStep);
      }, 300);
    }
  },

  clearHighlights() {
    this.highlightElements.forEach((el) => el.remove());
    this.highlightElements = [];
  },

  endGuide(isCompleted = false) {
    this.clearHighlights();

    this.guideElement.style.opacity = "0";
    this.guideElement.style.transform = "translateY(10px)";
    this.overlay.style.opacity = "0";

    setTimeout(() => {
      if (this.overlay && this.overlay.parentNode) {
        this.overlay.parentNode.removeChild(this.overlay);
      }
      if (this.guideElement && this.guideElement.parentNode) {
        this.guideElement.parentNode.removeChild(this.guideElement);
      }

      if (isCompleted && this.chatUrl) {
        window.open(this.chatUrl, "_blank");
      }
    }, 300);

    document.dispatchEvent(new Event("guideEnd"));
  },

  darkenColor(color, percent) {
    let R = parseInt(color.substring(1, 3), 16);
    let G = parseInt(color.substring(3, 5), 16);
    let B = parseInt(color.substring(5, 7), 16);

    R = parseInt((R * (100 - percent)) / 100);
    G = parseInt((G * (100 - percent)) / 100);
    B = parseInt((B * (100 - percent)) / 100);

    R = R < 255 ? R : 255;
    G = G < 255 ? G : 255;
    B = B < 255 ? B : 255;

    R = Math.round(R);
    G = Math.round(G);
    B = Math.round(B);

    const RR = R.toString(16).length === 1 ? "0" + R.toString(16) : R.toString(16);
    const GG = G.toString(16).length === 1 ? "0" + G.toString(16) : G.toString(16);
    const BB = B.toString(16).length === 1 ? "0" + B.toString(16) : B.toString(16);

    return `#${RR}${GG}${BB}`;
  },
};

export const style = document.createElement("style");
style.textContent = `
    @keyframes guide-pulse {
        0% { transform: scale(1); box-shadow: 0 0 0 0 rgba(79, 70, 229, 0.4); }
        70% { transform: scale(1); box-shadow: 0 0 0 10px rgba(79, 70, 229, 0); }
        100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(79, 70, 229, 0); }
    }
    
    .guide-content .highlight {
        font-weight: 700;
        color: #1a73e8;
    }
    
    .guide-content .warning {
        font-weight: 700;
        color: #d93025;
    }
`;
document.head.appendChild(style);
