"use strict";

const STORAGE_KEY = "gradewise-data-v2";

const DEFAULT_GRADES = [
  { grade: "A+", min: 90, point: 4.00 },
  { grade: "A",  min: 80, point: 3.75 },
  { grade: "B+", min: 70, point: 3.50 },
  { grade: "B",  min: 60, point: 3.00 },
  { grade: "C",  min: 50, point: 2.50 },
  { grade: "D",  min: 40, point: 1.75 },
  { grade: "F",  min: 0,  point: 0.00 }
];

let database = { semesters: [] };
let currentSemester = 1;
let currentView = "dashboard-view";
let toastTimeout;

let state = {
  marks: {},
  credits: {},
  grades: structuredClone(DEFAULT_GRADES)
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[char]);
}

function formatNumber(value, decimals = 2) {
  return Number(value).toFixed(decimals);
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");

  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toast.classList.remove("show"), 2800);
}

function loadSavedState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));

    if (saved && typeof saved === "object") {
      state.marks = saved.marks || {};
      state.credits = saved.credits || {};
      state.grades = Array.isArray(saved.grades) && saved.grades.length
        ? saved.grades
        : structuredClone(DEFAULT_GRADES);

      // Keep older saved data if the previous version used the old key.
      const old = JSON.parse(localStorage.getItem("gradewise-data-v1") || "null");
      if (old) {
        state.marks = { ...old.marks, ...state.marks };
        state.credits = { ...old.credits, ...state.credits };
      }
    } else {
      const old = JSON.parse(localStorage.getItem("gradewise-data-v1") || "null");
      if (old) {
        state.marks = old.marks || {};
        state.credits = old.credits || {};
        state.grades = old.grades || structuredClone(DEFAULT_GRADES);
      }
    }
  } catch (error) {
    console.warn("Saved data could not be read:", error);
    state = {
      marks: {},
      credits: {},
      grades: structuredClone(DEFAULT_GRADES)
    };
  }

  state.grades = state.grades
    .map((grade) => ({
      grade: String(grade.grade),
      min: Number(grade.min),
      point: Number(grade.point)
    }))
    .filter((grade) =>
      grade.grade && Number.isFinite(grade.min) &&
      Number.isFinite(grade.point)
    )
    .sort((a, b) => b.min - a.min);

  if (!state.grades.length) {
    state.grades = structuredClone(DEFAULT_GRADES);
  }
}

function saveState(message = "Changes saved in this browser.") {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    $("#saved-status").textContent = message;
  } catch (error) {
    $("#saved-status").textContent = "Could not save. Browser storage may be full.";
    console.error(error);
  }
}

function getSemesters() {
  return Array.isArray(database.semesters) ? database.semesters : [];
}

function getSubjects(semesterNumber) {
  const semester = getSemesters().find(
    (item) => Number(item.semester) === Number(semesterNumber)
  );

  return semester && Array.isArray(semester.subjects)
    ? semester.subjects
    : [];
}

function getSubjectKey(subject) {
  return String(subject.code);
}

function getSubjectCredit(subject) {
  const key = getSubjectKey(subject);

  if (state.credits[key] !== undefined &&
      state.credits[key] !== null &&
      state.credits[key] !== "") {
    const value = Number(state.credits[key]);
    return Number.isFinite(value) && value > 0 ? value : 0;
  }

  const original = Number(subject.credits);
  return Number.isFinite(original) && original > 0 ? original : 0;
}

function getComponents(subject) {
  return Array.isArray(subject.components) ? subject.components : [];
}

function getSavedMarks(subject) {
  const key = getSubjectKey(subject);

  if (!state.marks[key] || typeof state.marks[key] !== "object") {
    state.marks[key] = {};
  }

  const saved = state.marks[key];

  // Migrate values from the previous combined-mark version where possible.
  if (saved.internal !== undefined || saved.external !== undefined) {
    const components = getComponents(subject);
    const internalComponents = components.filter(c =>
      String(c.name).startsWith("Internal")
    );
    const finalComponents = components.filter(c =>
      String(c.name).startsWith("Final")
    );

    if (internalComponents.length === 1 &&
        saved[internalComponents[0].name] === undefined &&
        saved.internal !== "") {
      saved[internalComponents[0].name] = saved.internal;
    }

    if (finalComponents.length === 1 &&
        saved[finalComponents[0].name] === undefined &&
        saved.external !== "") {
      saved[finalComponents[0].name] = saved.external;
    }
  }

  return saved;
}

function getComponentGroups(subject) {
  const components = getComponents(subject);

  return {
    internal: components.filter(c =>
      String(c.name).startsWith("Internal")
    ),
    final: components.filter(c =>
      String(c.name).startsWith("Final")
    )
  };
}

function getSubjectMaxima(subject) {
  const groups = getComponentGroups(subject);

  return {
    internal: groups.internal.reduce((sum, c) => sum + Number(c.maxMarks || 0), 0),
    final: groups.final.reduce((sum, c) => sum + Number(c.maxMarks || 0), 0),
    total: getComponents(subject).reduce(
      (sum, c) => sum + Number(c.maxMarks || 0), 0
    )
  };
}

function getGrade(percentage) {
  const sorted = [...state.grades].sort((a, b) => b.min - a.min);
  return sorted.find((grade) => percentage >= grade.min) || sorted.at(-1);
}

function getPrediction(subject, overrides = null) {
  const saved = getSavedMarks(subject);
  const components = getComponents(subject);
  const groups = getComponentGroups(subject);

  let enteredTotal = 0;
  let totalMaximum = 0;
  let internalTotal = 0;
  let internalMaximum = 0;
  let finalTotal = 0;
  let finalMaximum = 0;
  let complete = components.length > 0;
  let hasInvalid = false;

  for (const component of components) {
    const name = component.name;
    const maximum = Number(component.maxMarks) || 0;
    const raw = overrides && Object.hasOwn(overrides, name)
      ? overrides[name]
      : saved[name];

    totalMaximum += maximum;

    const isInternal = String(name).startsWith("Internal");
    if (isInternal) internalMaximum += maximum;
    else finalMaximum += maximum;

    if (raw === "" || raw === undefined || raw === null) {
      complete = false;
      continue;
    }

    const mark = Number(raw);

    if (!Number.isFinite(mark) || mark < 0 || mark > maximum) {
      hasInvalid = true;
      complete = false;
      continue;
    }

    enteredTotal += mark;

    if (isInternal) internalTotal += mark;
    else finalTotal += mark;
  }

  const percentage = totalMaximum > 0
    ? (enteredTotal / totalMaximum) * 100
    : 0;

  const grade = complete && !hasInvalid ? getGrade(percentage) : null;

  return {
    internal: internalTotal,
    internalMaximum,
    final: finalTotal,
    finalMaximum,
    total: enteredTotal,
    totalMaximum,
    percentage,
    complete: complete && !hasInvalid,
    hasInvalid,
    grade,
    credit: getSubjectCredit(subject)
  };
}

function componentField(subject, component) {
  const saved = getSavedMarks(subject);
  const maximum = Number(component.maxMarks) || 0;
  const value = saved[component.name] ?? "";
  const invalid = value !== "" &&
    (!Number.isFinite(Number(value)) || Number(value) < 0 ||
     Number(value) > maximum);

  return `
    <div class="mark-field">
      <label for="${escapeHTML(subject.code)}-${escapeHTML(component.name)}">
        ${escapeHTML(component.name)}
        <span>/ ${maximum}</span>
      </label>
      <div class="mark-input-wrap ${invalid ? "invalid" : ""}">
        <input
          id="${escapeHTML(subject.code)}-${escapeHTML(component.name)}"
          type="number"
          min="0"
          max="${maximum}"
          step="any"
          inputmode="decimal"
          autocomplete="off"
          data-subject="${escapeHTML(subject.code)}"
          data-component="${escapeHTML(component.name)}"
          value="${escapeHTML(value)}"
          placeholder="0–${maximum}"
          aria-label="${escapeHTML(component.name)} marks out of ${maximum}"
        >
        <span>/${maximum}</span>
      </div>
    </div>
  `;
}

function renderSubjectCard(subject) {
  const groups = getComponentGroups(subject);
  const prediction = getPrediction(subject);
  const maxima = getSubjectMaxima(subject);

  const creditLabel = prediction.credit > 0
    ? `${prediction.credit} credit hour${prediction.credit === 1 ? "" : "s"}`
    : "Credits not set";

  const componentFields = getComponents(subject).map(componentField.bind(null, subject));

  const internalFields = groups.internal.map(component =>
    componentField(subject, component)
  ).join("");

  const finalFields = groups.final.map(component =>
    componentField(subject, component)
  ).join("");

  const gradeMarkup = prediction.complete && prediction.grade
    ? `<span class="grade-pill">${escapeHTML(prediction.grade.grade)} · ${formatNumber(prediction.grade.point)}</span>`
    : `<span class="grade-pill unavailable">Awaiting marks</span>`;

  const percentageText = prediction.complete
    ? `${formatNumber(prediction.percentage, 1)}%`
    : "Incomplete";

  return `
    <article class="subject-card" data-card-code="${escapeHTML(subject.code)}">
      <div class="subject-heading">
        <div>
          <h3>${escapeHTML(subject.name)}</h3>
          <div class="subject-code">
            ${escapeHTML(subject.code)} · ${escapeHTML(creditLabel)}
          </div>
        </div>
        <div class="subject-total">
          <strong data-total-for="${escapeHTML(subject.code)}">
            ${formatNumber(prediction.total, 1)} / ${formatNumber(maxima.total, 1)}
          </strong>
          <span data-percent-for="${escapeHTML(subject.code)}">${percentageText}</span>
          <br>
          ${gradeMarkup}
        </div>
      </div>

      ${groups.internal.length ? `
        <div class="component-group">
          <p class="component-group-title">INTERNAL ASSESSMENT</p>
          <div class="marks-inputs">
            ${internalFields}
          </div>
        </div>
      ` : ""}

      ${groups.final.length ? `
        <div class="component-group">
          <p class="component-group-title">FINAL ASSESSMENT</p>
          <div class="marks-inputs">
            ${finalFields}
          </div>
        </div>
      ` : ""}

      <div class="subject-meta">
        <span>Internal total: <strong data-internal-for="${escapeHTML(subject.code)}">${formatNumber(prediction.internal, 1)} / ${formatNumber(maxima.internal, 1)}</strong></span>
        <span>Final total: <strong data-final-for="${escapeHTML(subject.code)}">${formatNumber(prediction.final, 1)} / ${formatNumber(maxima.final, 1)}</strong></span>
      </div>
    </article>
  `;
}

function renderSubjects() {
  const subjects = getSubjects(currentSemester);

  $("#marks-heading").textContent = `Semester ${currentSemester} marks`;

  $("#subject-list").innerHTML = subjects.length
    ? subjects.map(renderSubjectCard).join("")
    : `<p class="muted">No subjects are listed for this semester.</p>`;

  updateDashboard();
}

function getCurrentPredictions() {
  return getSubjects(currentSemester).map(subject => ({
    subject,
    ...getPrediction(subject)
  }));
}

function calculateGPA(predictions) {
  const completed = predictions.filter(item => item.complete);

  if (!completed.length) {
    return {
      value: null,
      weighted: false,
      completed: 0,
      total: predictions.length
    };
  }

  const allCreditsKnown = completed.every(item => item.credit > 0);
  const totalCredits = completed.reduce((sum, item) => sum + item.credit, 0);

  const value = allCreditsKnown && totalCredits > 0
    ? completed.reduce(
        (sum, item) => sum + item.grade.point * item.credit, 0
      ) / totalCredits
    : completed.reduce((sum, item) => sum + item.grade.point, 0) / completed.length;

  return {
    value,
    weighted: allCreditsKnown && totalCredits > 0,
    completed: completed.length,
    total: predictions.length
  };
}

function setProgress(id, percentage) {
  const element = $(id);
  if (element) {
    element.style.width = `${Math.max(0, Math.min(100, percentage))}%`;
  }
}

function updateDashboard() {
  const predictions = getCurrentPredictions();
  const completed = predictions.filter(item => item.complete);
  const gpa = calculateGPA(predictions);

  $("#completed-value").textContent = `${completed.length}/${predictions.length}`;
  setProgress("#completed-progress",
    predictions.length ? completed.length / predictions.length * 100 : 0);

  if (completed.length) {
    const average = completed.reduce((sum, item) => sum + item.percentage, 0)
      / completed.length;

    $("#average-value").textContent = `${formatNumber(average, 1)}%`;
    setProgress("#average-progress", average);
  } else {
    $("#average-value").textContent = "—";
    setProgress("#average-progress", 0);
  }

  const internalEntered = predictions.reduce((sum, item) => sum + item.internal, 0);
  const internalMax = predictions.reduce((sum, item) => sum + item.internalMaximum, 0);

  $("#internal-value").textContent = internalMax
    ? `${formatNumber(internalEntered, 1)}/${formatNumber(internalMax, 1)}`
    : "—";

  setProgress("#internal-progress",
    internalMax ? internalEntered / internalMax * 100 : 0);

  $("#gpa-value").textContent = gpa.value === null
    ? "—"
    : formatNumber(gpa.value);

  $("#gpa-caption").textContent = gpa.value === null
    ? "Enter all required marks for a subject."
    : gpa.weighted
      ? "Credit-weighted estimate for completed subjects."
      : "Unweighted estimate; some credit hours are unknown.";

  setProgress("#gpa-progress", gpa.value === null ? 0 : gpa.value / 4 * 100);

  renderChart(predictions);
  updatePlanner();
}

function renderChart(predictions) {
  const chart = $("#performance-chart");

  const withMarks = predictions.filter(item =>
    item.totalMaximum > 0 && item.total > 0
  );

  if (!withMarks.length) {
    chart.innerHTML = `<p class="muted">Your subject performance will appear here after you enter marks.</p>`;
    return;
  }

  chart.innerHTML = withMarks.map(item => {
    const percentage = item.percentage;
    const label = item.complete
      ? item.grade.grade
      : `${formatNumber(percentage, 0)}%`;

    return `
      <div class="chart-row">
        <div>
          <div class="chart-label">
            <span title="${escapeHTML(item.subject.name)}">${escapeHTML(item.subject.name)}</span>
            <strong>${formatNumber(percentage, 1)}%</strong>
          </div>
          <div class="chart-track">
            <div class="chart-fill" style="width:${Math.min(100, percentage)}%"></div>
          </div>
        </div>
        <div class="chart-grade">${escapeHTML(label)}</div>
      </div>
    `;
  }).join("");
}

function getScenarioPredictions(increasePercent) {
  return getSubjects(currentSemester).map(subject => {
    const saved = getSavedMarks(subject);
    const overrides = {};

    for (const component of getComponents(subject)) {
      const raw = saved[component.name];
      const maximum = Number(component.maxMarks) || 0;

      if (raw === "" || raw === undefined || raw === null) {
        overrides[component.name] = "";
        continue;
      }

      let mark = Number(raw);

      if (String(component.name).startsWith("Final")) {
        mark += maximum * increasePercent / 100;
      }

      overrides[component.name] = String(Math.min(maximum, mark));
    }

    return {
      subject,
      ...getPrediction(subject, overrides)
    };
  });
}

function updatePlanner() {
  const target = Number($("#target-gpa").value);
  $("#target-gpa-display").textContent = formatNumber(target);

  const increase = Number($("#scenario-select").value);
  const predictions = getScenarioPredictions(increase);
  const gpa = calculateGPA(predictions);

  if (gpa.value === null) {
    $("#scenario-result").textContent = "Your plan is ready.";
    $("#scenario-caption").textContent =
      "Enter all required marks for at least one subject to calculate a GPA estimate.";
    return;
  }

  $("#scenario-result").textContent = gpa.value >= target
    ? "You're on track to reach your target."
    : "Your current estimate is below your target.";

  $("#scenario-caption").textContent =
    `Estimated GPA: ${formatNumber(gpa.value)} / 4.00. ` +
    (gpa.weighted ? "Credit-weighted." : "Unweighted because credits are missing.") +
    (increase ? ` Scenario assumes up to ${increase}% improvement in final marks.` : "");
}

function renderGradeSettings() {
  $("#grade-settings-body").innerHTML = [...state.grades]
    .sort((a, b) => b.min - a.min)
    .map((grade, index) => `
      <tr>
        <td><strong>${escapeHTML(grade.grade)}</strong></td>
        <td>
          <input type="number" min="0" max="100" step="any"
                 data-grade-min="${escapeHTML(grade.grade)}"
                 value="${grade.min}">
        </td>
        <td>
          <input type="number" min="0" max="4" step="0.01"
                 data-grade-point="${escapeHTML(grade.grade)}"
                 value="${formatNumber(grade.point)}">
        </td>
      </tr>
    `).join("");
}

function renderCreditSettings() {
  const rows = getSemesters().flatMap(semester =>
    (semester.subjects || []).map(subject => ({
      semester: semester.semester,
      subject
    }))
  );

  $("#credit-settings").innerHTML = rows.map(({ semester, subject }) => {
    const key = getSubjectKey(subject);
    const credit = getSubjectCredit(subject);

    return `
      <div class="credit-row">
        <div>
          <strong>${escapeHTML(subject.name)}</strong>
          <small>Semester ${semester} · ${escapeHTML(subject.code)}</small>
        </div>
        <input type="number" min="0" step="0.5"
               data-credit-code="${escapeHTML(key)}"
               value="${credit > 0 ? escapeHTML(credit) : ""}"
               placeholder="Unknown">
      </div>
    `;
  }).join("");
}

function renderSemesterCards() {
  $("#semester-cards").innerHTML = getSemesters().map(semester => {
    const predictions = (semester.subjects || []).map(subject => ({
      subject,
      ...getPrediction(subject)
    }));

    const gpa = calculateGPA(predictions);
    const completed = predictions.filter(item => item.complete).length;

    return `
      <article class="semester-card">
        <p class="eyebrow">SEMESTER ${semester.semester}</p>
        <h3>Semester ${semester.semester}</h3>
        <p>${completed} of ${predictions.length} subjects completed</p>
        <div class="semester-card-bottom">
          <strong>${gpa.value === null ? "—" : formatNumber(gpa.value)}</strong>
          <button class="button button-outline" type="button"
                  data-open-semester="${semester.semester}">
            Open semester →
          </button>
        </div>
      </article>
    `;
  }).join("");
}

function showView(view) {
  const validViews = [
    "dashboard-view",
    "subjects-view",
    "settings-view",
    "result-view"
  ];

  if (!validViews.includes(view)) return;

  currentView = view;

  $$(".app-view").forEach(section => {
    section.classList.toggle("hidden", section.id !== view);
  });

  $$(".nav-item").forEach(button => {
    button.classList.toggle("active", button.dataset.view === view);
  });

  const titles = {
    "dashboard-view": "Dashboard",
    "subjects-view": "My semesters",
    "settings-view": "Grade settings",
    "result-view": "Predicted result"
  };

  $("#page-title").textContent = titles[view];

  if (view === "subjects-view") renderSemesterCards();
  if (view === "settings-view") {
    renderGradeSettings();
    renderCreditSettings();
  }
  if (view === "result-view") renderResultReport();

  window.scrollTo({ top: 0, behavior: "smooth" });
}

function validateMarksInput(input) {
  const subject = getSubjects(currentSemester).find(
    item => item.code === input.dataset.subject
  );

  const component = getComponents(subject || {}).find(
    item => item.name === input.dataset.component
  );

  if (!subject || !component) return false;

  const raw = input.value;
  if (raw === "") return true;

  const value = Number(raw);
  return Number.isFinite(value) &&
    value >= 0 &&
    value <= Number(component.maxMarks);
}

function handleMarkInput(event) {
  const input = event.target;
  if (!input.matches("[data-subject][data-component]")) return;

  const subject = getSubjects(currentSemester).find(
    item => item.code === input.dataset.subject
  );

  if (!subject) return;

  const saved = getSavedMarks(subject);
  const raw = input.value;
  const maximum = Number(
    getComponents(subject).find(c => c.name === input.dataset.component)?.maxMarks
  );

  input.closest(".mark-input-wrap").classList.toggle(
    "invalid",
    raw !== "" && (!Number.isFinite(Number(raw)) ||
      Number(raw) < 0 || Number(raw) > maximum)
  );

  saved[input.dataset.component] = raw;

  saveState("Marks saved automatically.");
  updateSubjectSummary(subject);
  updateDashboard();
}

function updateSubjectSummary(subject) {
  const prediction = getPrediction(subject);
  const maxima = getSubjectMaxima(subject);
  const code = CSS.escape(getSubjectKey(subject));

  const total = document.querySelector(`[data-total-for="${code}"]`);
  const percentage = document.querySelector(`[data-percent-for="${code}"]`);
  const internal = document.querySelector(`[data-internal-for="${code}"]`);
  const final = document.querySelector(`[data-final-for="${code}"]`);
  const card = document.querySelector(`[data-card-code="${code}"]`);

  if (total) {
    total.textContent =
      `${formatNumber(prediction.total, 1)} / ${formatNumber(maxima.total, 1)}`;
  }

  if (percentage) {
    percentage.textContent = prediction.complete
      ? `${formatNumber(prediction.percentage, 1)}%`
      : "Incomplete";
  }

  if (internal) {
    internal.textContent =
      `${formatNumber(prediction.internal, 1)} / ${formatNumber(maxima.internal, 1)}`;
  }

  if (final) {
    final.textContent =
      `${formatNumber(prediction.final, 1)} / ${formatNumber(maxima.final, 1)}`;
  }

  if (card) {
    const heading = card.querySelector(".subject-total");
    if (heading) {
      const oldPill = heading.querySelector(".grade-pill");
      if (oldPill) {
        oldPill.className = prediction.complete
          ? "grade-pill"
          : "grade-pill unavailable";

        oldPill.textContent = prediction.complete && prediction.grade
          ? `${prediction.grade.grade} · ${formatNumber(prediction.grade.point)}`
          : "Awaiting marks";
      }
    }
  }
}

function resetCurrentSemester() {
  const subjects = getSubjects(currentSemester);
  if (!subjects.length) return;

  const confirmed = window.confirm(
    `Clear all saved marks for Semester ${currentSemester}? This cannot be undone.`
  );

  if (!confirmed) return;

  subjects.forEach(subject => {
    delete state.marks[getSubjectKey(subject)];
  });

  saveState("Semester marks cleared.");
  renderSubjects();
  showToast(`Semester ${currentSemester} marks have been cleared.`);
}

function saveGradeSettings() {
  const nextGrades = state.grades.map(grade => {
    const minInput = document.querySelector(
      `[data-grade-min="${CSS.escape(grade.grade)}"]`
    );
    const pointInput = document.querySelector(
      `[data-grade-point="${CSS.escape(grade.grade)}"]`
    );

    return {
      grade: grade.grade,
      min: Number(minInput.value),
      point: Number(pointInput.value)
    };
  });

  const invalid = nextGrades.some(grade =>
    !Number.isFinite(grade.min) || grade.min < 0 || grade.min > 100 ||
    !Number.isFinite(grade.point) || grade.point < 0 || grade.point > 4
  );

  if (invalid) {
    showToast("Grade thresholds must be 0–100 and grade points 0–4.");
    return;
  }

  const thresholds = nextGrades.map(grade => grade.min);
  if (new Set(thresholds).size !== thresholds.length) {
    showToast("Each grade must have a unique minimum percentage.");
    return;
  }

  if (!nextGrades.some(grade => grade.min === 0)) {
    showToast("At least one grade must begin at 0%.");
    return;
  }

  state.grades = nextGrades.sort((a, b) => b.min - a.min);
  saveState("Grade settings saved.");
  renderSubjects();
  renderGradeSettings();
  renderSemesterCards();
  showToast("Grade settings updated.");
}

function saveCreditSettings() {
  const inputs = $$("[data-credit-code]");
  const nextCredits = { ...state.credits };

  for (const input of inputs) {
    if (input.value === "") {
      delete nextCredits[input.dataset.creditCode];
      continue;
    }

    const value = Number(input.value);

    if (!Number.isFinite(value) || value < 0) {
      showToast("Credit hours must be zero or greater.");
      return;
    }

    nextCredits[input.dataset.creditCode] = value;
  }

  state.credits = nextCredits;
  saveState("Credit hours saved.");
  renderSubjects();
  renderCreditSettings();
  renderSemesterCards();
  showToast("Credit hours updated.");
}

function restoreExampleGrades() {
  state.grades = structuredClone(DEFAULT_GRADES);
  saveState("Default grade settings restored.");
  renderGradeSettings();
  renderSubjects();
  showToast("Default grade settings restored.");
}

function renderResultReport() {
  const predictions = getCurrentPredictions();
  const completed = predictions.filter(item => item.complete);
  const gpa = calculateGPA(predictions);

  $("#report-semester").textContent = `Semester ${currentSemester}`;
  $("#report-gpa").textContent = gpa.value === null
    ? "—"
    : formatNumber(gpa.value);

  $("#report-gpa-note").textContent = gpa.value === null
    ? "Enter all marks for a subject."
    : gpa.weighted
      ? "Credit-weighted estimate"
      : "Unweighted estimate — credits incomplete";

  const average = completed.length
    ? completed.reduce((sum, item) => sum + item.percentage, 0) / completed.length
    : null;

  $("#report-average").textContent = average === null
    ? "—"
    : `${formatNumber(average, 1)}%`;

  $("#report-completed").textContent = `${completed.length}/${predictions.length}`;
  $("#report-total-subjects").textContent =
    `${predictions.length} subjects in this semester`;

  $("#report-notice").textContent = completed.length === predictions.length
    ? "All subjects have complete marks entered. Check your institution's official grading rules before relying on this estimate."
    : `${predictions.length - completed.length} subject(s) still have missing or invalid marks. Only fully completed subjects are included in the GPA estimate.`;

  $("#report-table-body").innerHTML = predictions.map(item => {
    const maxima = getSubjectMaxima(item.subject);

    return `
      <tr>
        <td>
          <strong>${escapeHTML(item.subject.name)}</strong>
          <br><small>${escapeHTML(item.subject.code)}</small>
        </td>
        <td>${formatNumber(item.internal, 1)} / ${formatNumber(maxima.internal, 1)}</td>
        <td>${formatNumber(item.final, 1)} / ${formatNumber(maxima.final, 1)}</td>
        <td>${formatNumber(item.total, 1)} / ${formatNumber(item.totalMaximum, 1)}</td>
        <td>${item.complete ? `${formatNumber(item.percentage, 1)}%` : "Incomplete"}</td>
        <td>${item.complete && item.grade
          ? `${escapeHTML(item.grade.grade)} (${formatNumber(item.grade.point)})`
          : "—"}</td>
        <td>${item.credit > 0 ? escapeHTML(item.credit) : "—"}</td>
      </tr>
    `;
  }).join("");
}

function openSemester(semesterNumber) {
  currentSemester = Number(semesterNumber);
  $("#semester-select").value = String(currentSemester);
  renderSubjects();
  showView("dashboard-view");
}

function bindEvents() {
  $$(".nav-item").forEach(button => {
    button.addEventListener("click", () => showView(button.dataset.view));
  });

  $("#semester-select").addEventListener("change", event => {
    currentSemester = Number(event.target.value);
    renderSubjects();
  });

  $("#subject-list").addEventListener("input", handleMarkInput);

  $("#clear-semester").addEventListener("click", resetCurrentSemester);

  $("#see-result").addEventListener("click", () => {
    renderResultReport();
    showView("result-view");
  });

  $("#back-to-dashboard").addEventListener("click", () => {
    showView("dashboard-view");
  });

  $("#print-result").addEventListener("click", () => window.print());

  $("#target-gpa").addEventListener("input", updatePlanner);
  $("#scenario-select").addEventListener("change", updatePlanner);

  $("#apply-scenario").addEventListener("click", () => {
    updatePlanner();
    showToast("Your prediction has been updated.");
  });

  $("#save-settings").addEventListener("click", saveGradeSettings);
  $("#reset-grades").addEventListener("click", restoreExampleGrades);
  $("#save-credits").addEventListener("click", saveCreditSettings);

  $("#semester-cards").addEventListener("click", event => {
    const button = event.target.closest("[data-open-semester]");
    if (button) openSemester(button.dataset.openSemester);
  });
}

function initSemesterPicker() {
  const semesters = getSemesters();

  $("#semester-select").innerHTML = semesters.map(semester => `
    <option value="${Number(semester.semester)}">
      Semester ${Number(semester.semester)}
    </option>
  `).join("");

  if (semesters.length) {
    currentSemester = Number(semesters[0].semester);
    $("#semester-select").value = String(currentSemester);
  }
}

async function init() {
  loadSavedState();

  try {
    const response = await fetch("./subjects.json", { cache: "no-store" });

    if (!response.ok) {
      throw new Error(`Could not load subjects.json (${response.status}).`);
    }

    database = await response.json();

    if (!Array.isArray(database.semesters)) {
      throw new Error("subjects.json must contain a semesters array.");
    }

    initSemesterPicker();
    bindEvents();
    renderSubjects();
    renderGradeSettings();
    renderCreditSettings();
    renderSemesterCards();
    saveState();
  } catch (error) {
    console.error(error);

    $("#subject-list").innerHTML = `
      <div class="settings-warning">
        <strong>Gradewise couldn't load your subjects.</strong>
        <p>${escapeHTML(error.message)}</p>
        <p>Make sure subjects.json is in the same folder as index.html and script.js,
        then run the project using VS Code Live Server instead of opening the HTML
        file directly.</p>
      </div>
    `;
  }
}

document.addEventListener("DOMContentLoaded", init);