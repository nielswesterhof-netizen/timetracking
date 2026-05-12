const app = document.querySelector('#app');
const today = new Date().toISOString().slice(0, 10);
const thisMonth = new Date().toISOString().slice(0, 7);
const leaveRows = [
  { leave_type: 'sick', name: 'Sick leave' },
  { leave_type: 'holiday', name: 'Holiday leave' },
];

let supabaseClient;
let currentSession = null;
let currentProfile = null;
let profileLoadError = '';
let activeTab = 'time';
let timeView = 'month';
let selectedWeekStart = null;
let timePeriod = thisMonth;
let hasUnsavedHours = false;

window.addEventListener('beforeunload', (event) => {
  if (!hasUnsavedHours) return;

  event.preventDefault();
  event.returnValue = '';
});

function lastDayOfMonth(month) {
  const [year, monthNumber] = month.split('-').map(Number);
  return formatLocalDate(new Date(year, monthNumber, 0));
}

function daysInMonth(month) {
  const endDate = lastDayOfMonth(month);
  const days = [];
  let cursor = new Date(`${month}-01T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);

  while (cursor <= end) {
    days.push(formatLocalDate(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }

  return days;
}

function daysInWeek(dateValue) {
  const selected = new Date(`${dateValue}T00:00:00`);
  const day = selected.getDay() || 7;
  const monday = new Date(selected);
  monday.setDate(selected.getDate() - day + 1);

  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(monday);
    date.setDate(monday.getDate() + index);
    return formatLocalDate(date);
  });
}

function formatLocalDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function dayLabel(dateValue) {
  const date = new Date(`${dateValue}T00:00:00`);
  return date.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit' });
}

function monthLabel(month) {
  const date = new Date(`${month}-01T00:00:00`);
  return date.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}

function isWeekend(dateValue) {
  const day = new Date(`${dateValue}T00:00:00`).getDay();
  return day === 0 || day === 6;
}

function getWeekStart() {
  const firstMonthDay = `${timePeriod}-01`;
  const preferredDay = selectedWeekStart && selectedWeekStart.startsWith(timePeriod)
    ? selectedWeekStart
    : firstMonthDay;
  return daysInWeek(preferredDay)[0];
}

function weekOptionsForMonth(month) {
  const monthDays = daysInMonth(month);
  const starts = [];

  monthDays.forEach((day) => {
    const start = daysInWeek(day)[0];
    if (!starts.includes(start)) starts.push(start);
  });

  return starts;
}

function startApp() {
  if (!window.APP_CONFIG?.supabaseUrl || !window.APP_CONFIG?.supabaseAnonKey) {
    app.innerHTML = `
      <main class="center-screen">
        <section class="panel setup-warning">
          <h1>Supabase setup needed</h1>
          <p>Open <strong>src/config.js</strong> and paste your Supabase Project URL and anon public key.</p>
        </section>
      </main>
    `;
    return;
  }

  supabaseClient = createSimpleClient(
    window.APP_CONFIG.supabaseUrl,
    window.APP_CONFIG.supabaseAnonKey
  );

  supabaseClient.auth.onAuthStateChange(async (_event, session) => {
    currentSession = session;
    await loadProfile();
    render();
  });

  boot();
}

async function boot() {
  const { data } = await supabaseClient.auth.getSession();
  currentSession = data.session;
  await loadProfile();
  render();
}

async function loadProfile() {
  const userId = getSessionUserId();

  if (!userId) {
    currentProfile = null;
    profileLoadError = '';
    return;
  }

  const { data, error } = await supabaseClient
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single();

  if (data) {
    currentProfile = data;
    profileLoadError = '';
    return;
  }

  if (error && isLoginExpiredError(error)) {
    currentSession = null;
    currentProfile = null;
    profileLoadError = '';
    localStorage.removeItem('time_tracker_session');
    return;
  }

  const repairedProfile = await repairMissingProfile();
  if (repairedProfile) {
    currentProfile = repairedProfile;
    profileLoadError = '';
    return;
  }

  profileLoadError = error || 'No employee profile was found for this account.';
  currentProfile = fallbackProfile();
}

async function repairMissingProfile() {
  const fallback = fallbackProfile();
  const { data } = await supabaseClient.rpc('ensure_my_profile', {
    p_full_name: fallback.full_name,
    p_email: fallback.email,
  });

  return data || null;
}

function render() {
  if (!currentSession) {
    renderAuth();
    return;
  }

  if (!currentProfile) {
    app.innerHTML = `
      <main class="center-screen">
        <section class="panel setup-warning">
          <h1>Workspace could not load</h1>
          <p>Please log out and log in again. If this keeps happening, ask a manager to check the Employees table in Supabase.</p>
          <button class="primary-button" id="force-logout-button">Logout</button>
        </section>
      </main>
    `;
    document.querySelector('#force-logout-button').addEventListener('click', () => supabaseClient.auth.signOut());
    return;
  }

  renderDashboard();
}

function fallbackProfile() {
  const payload = getJwtPayload(currentSession?.access_token) || {};

  return {
    id: getSessionUserId(),
    full_name: currentSession?.user?.user_metadata?.full_name || payload.user_metadata?.full_name || '',
    email: currentSession?.user?.email || payload.email || '',
    role: 'employee',
    working_hours_per_week: 40,
    hourly_rate_eur: 0,
    is_fallback: true,
  };
}

function isLoginExpiredError(error) {
  const text = errorText(error).toLowerCase();
  return text.includes('jwt') || text.includes('expired') || text.includes('invalid token');
}

function renderAuth() {
  app.innerHTML = `
    <main class="auth-page">
      <section class="auth-panel">
        <div>
          <p class="eyebrow">Team Time Tracker</p>
          <h1>Log daily hours without spreadsheet chaos.</h1>
          <p class="muted">Employees track project hours. Managers manage people, projects, reports, and exports.</p>
        </div>
        <form class="auth-card" id="auth-form">
          <div class="segmented">
            <button type="button" class="active" id="login-tab">Login</button>
            <button type="button" id="signup-tab">Create account</button>
          </div>
          <div id="name-field"></div>
          <label>Email <input id="email" type="email" placeholder="you@company.com" required /></label>
          <label>Password <input id="password" type="password" placeholder="At least 6 characters" required /></label>
          <button class="primary-button" id="auth-submit" type="submit">Login</button>
          <p class="notice hidden" id="auth-message"></p>
        </form>
      </section>
    </main>
  `;

  let mode = 'login';
  const nameField = document.querySelector('#name-field');
  const loginTab = document.querySelector('#login-tab');
  const signupTab = document.querySelector('#signup-tab');
  const submitButton = document.querySelector('#auth-submit');

  function setMode(nextMode) {
    mode = nextMode;
    loginTab.classList.toggle('active', mode === 'login');
    signupTab.classList.toggle('active', mode === 'signup');
    submitButton.textContent = mode === 'login' ? 'Login' : 'Create account';
    nameField.innerHTML = mode === 'signup'
      ? '<label>Full name <input id="full-name" placeholder="Jane Smith" required /></label>'
      : '';
  }

  loginTab.addEventListener('click', () => setMode('login'));
  signupTab.addEventListener('click', () => setMode('signup'));

  document.querySelector('#auth-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const email = document.querySelector('#email').value;
    const password = document.querySelector('#password').value;
    const message = document.querySelector('#auth-message');
    message.classList.add('hidden');

    if (mode === 'signup') {
      const fullName = document.querySelector('#full-name').value;
      const { error } = await supabaseClient.auth.signUp({
        email,
        password,
        options: { data: { full_name: fullName } },
      });
      showMessage(
        message,
        error ? errorText(error) : 'Account created. If you receive a confirmation email, click the link before logging in.',
        Boolean(error)
      );
      return;
    }

    const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
    if (error) showMessage(message, errorText(error), true);
  });
}

function renderDashboard() {
  const isManager = currentProfile.role === 'manager';
  app.innerHTML = `
    <main class="app-shell">
      <aside class="sidebar">
        <div class="brand">
          <span class="brand-icon">◷</span>
          <div>
            <strong>Time Tracker</strong>
            <span>${escapeHtml(currentProfile.full_name || currentSession.user.email)}</span>
          </div>
        </div>
        <nav>
          ${navButton('time', 'Time tracking')}
          ${navButton('reports', 'Monthly reports')}
          ${isManager ? navButton('employees', 'Employees') : ''}
          ${isManager ? navButton('projects', 'Projects') : ''}
        </nav>
        <button class="ghost-button logout" id="logout-button">Logout</button>
      </aside>
      <section class="content">
        <header class="topbar">
          <div>
            <p class="eyebrow">${isManager ? 'Manager workspace' : 'Employee workspace'}</p>
            <h1>${tabTitle(activeTab)}</h1>
          </div>
          <div class="role-pill">${currentProfile.role}</div>
        </header>
        ${currentProfile.is_fallback ? `<p class="notice error">${escapeHtml(profileLoadError)} Run supabase/fix-profile-loading.sql in Supabase, then refresh and log in again.</p>` : ''}
        <div id="tab-content"></div>
      </section>
    </main>
  `;

  document.querySelectorAll('[data-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      activeTab = button.dataset.tab;
      renderDashboard();
    });
  });

  document.querySelector('#logout-button').addEventListener('click', () => {
    if (hasUnsavedHours && !confirm('You have unsaved hours. If you log out now, those changes will be lost. Log out anyway?')) {
      return;
    }

    hasUnsavedHours = false;
    supabaseClient.auth.signOut();
  });

  if (activeTab === 'time') renderTimeTracking();
  if (activeTab === 'reports') renderReports();
  if (activeTab === 'employees' && isManager) renderEmployees();
  if (activeTab === 'projects' && isManager) renderProjects();
}

function navButton(tab, label) {
  return `<button class="nav-button ${activeTab === tab ? 'active' : ''}" data-tab="${tab}">${label}</button>`;
}

function tabTitle(tab) {
  return {
    time: 'Daily hours',
    reports: 'Monthly reports',
    employees: 'Employees',
    projects: 'Projects',
  }[tab];
}

async function renderTimeTracking() {
  const content = document.querySelector('#tab-content');
  const visibleDays = timeView === 'month' ? daysInMonth(timePeriod) : daysInWeek(getWeekStart());
  const startDate = visibleDays[0];
  const endDate = visibleDays[visibleDays.length - 1];
  const [{ data: projects, error: projectsError }, { data: entries, error: entriesError }] = await Promise.all([
    supabaseClient.from('projects').select('*').eq('is_active', true).order('name'),
    supabaseClient
      .from('time_entries')
      .select('id, project_id, leave_type, entry_date, hours, notes, projects(name)')
      .eq('employee_id', getSessionUserId())
      .gte('entry_date', startDate)
      .lte('entry_date', endDate)
      .order('entry_date', { ascending: true }),
  ]);
  const projectRows = projects || [];
  const entryRows = entries || [];
  const loadError = projectsError || entriesError;
  const entryMap = new Map(entryRows.map((entry) => [entryKey(entry), entry]));

  content.innerHTML = `
    <section class="panel">
      <div class="actions time-toolbar">
        <input id="time-period" type="month" value="${timePeriod}" aria-label="Month" />
        <div class="segmented compact">
          <button type="button" class="${timeView === 'month' ? 'active' : ''}" id="month-view">Month</button>
          <button type="button" class="${timeView === 'week' ? 'active' : ''}" id="week-view">Week</button>
        </div>
        ${timeView === 'week' ? weekSelect() : ''}
      </div>
      ${loadError ? `<p class="notice error">${escapeHtml(loadError)}</p>` : ''}
      <p class="notice hidden" id="entry-message"></p>
      ${projectRows.length ? hoursGrid(projectRows, visibleDays, entryMap) : '<p class="notice error">No active projects found. Ask a manager to add a project first.</p>'}
      <div class="grid-save-row">
        <button class="primary-button" id="save-grid-button" type="button" disabled>Save changes</button>
      </div>
    </section>
  `;

  document.querySelector('#time-period').addEventListener('change', (event) => {
    if (!confirmDiscardUnsavedChanges()) {
      event.target.value = timePeriod;
      return;
    }

    timePeriod = event.target.value;
    selectedWeekStart = null;
    renderTimeTracking();
  });

  document.querySelector('#month-view').addEventListener('click', () => {
    if (!confirmDiscardUnsavedChanges()) return;

    timeView = 'month';
    renderTimeTracking();
  });

  document.querySelector('#week-view').addEventListener('click', () => {
    if (!confirmDiscardUnsavedChanges()) return;

    timeView = 'week';
    selectedWeekStart = getWeekStart();
    renderTimeTracking();
  });

  const weekSelectElement = document.querySelector('#week-start');
  if (weekSelectElement) {
    weekSelectElement.addEventListener('change', (event) => {
      if (!confirmDiscardUnsavedChanges()) {
        event.target.value = selectedWeekStart || getWeekStart();
        return;
      }

      selectedWeekStart = event.target.value;
      renderTimeTracking();
    });
  }

  document.querySelectorAll('.hours-cell').forEach((input) => {
    input.addEventListener('input', () => {
      input.dataset.changed = 'true';
      hasUnsavedHours = true;
      document.querySelector('#save-grid-button').disabled = false;
    });
  });

  document.querySelector('#save-grid-button').addEventListener('click', saveGridChanges);
}

function weekSelect() {
  const options = weekOptionsForMonth(timePeriod);
  const current = getWeekStart();

  return `
    <select class="week-select" id="week-start" aria-label="Week">
      ${options.map((start) => {
        const days = daysInWeek(start);
        const end = days[days.length - 1];
        return `<option value="${start}" ${start === current ? 'selected' : ''}>${dayLabel(start)} - ${dayLabel(end)}</option>`;
      }).join('')}
    </select>
  `;
}

function hoursGrid(projectRows, visibleDays, entryMap) {
  const totalDays = visibleDays.filter((day) => day.startsWith(timePeriod));

  return `
    <div class="hours-grid-wrap">
      <table class="hours-grid">
        <thead>
          <tr>
            <th class="project-column">Project</th>
            ${visibleDays.map((day) => `<th class="${dayClass(day)}">${dayLabel(day)}</th>`).join('')}
            <th>Total</th>
          </tr>
        </thead>
        <tbody>
          ${projectRows.map((project) => sheetRow({
            label: project.name,
            rowKey: project.id,
            projectId: project.id,
            leaveType: '',
            visibleDays,
            totalDays,
            entryMap,
          })).join('')}
          ${leaveRows.map((leaveRow) => sheetRow({
            label: leaveRow.name,
            rowKey: leaveRow.leave_type,
            projectId: '',
            leaveType: leaveRow.leave_type,
            visibleDays,
            totalDays,
            entryMap,
            rowClass: 'leave-row',
          })).join('')}
        </tbody>
        <tfoot>
          <tr>
            <th class="project-column">Total</th>
            ${visibleDays.map((day) => {
              const dayTotal = Array.from(entryMap.values())
                .filter((entry) => entry.entry_date === day && day.startsWith(timePeriod))
                .reduce((sum, entry) => sum + Number(entry.hours || 0), 0);
              return `<th class="${dayClass(day)}">${dayTotal ? dayTotal.toFixed(2) : ''}</th>`;
            }).join('')}
            <th>${Array.from(entryMap.values())
              .filter((entry) => totalDays.includes(entry.entry_date))
              .reduce((sum, entry) => sum + Number(entry.hours || 0), 0)
              .toFixed(2)}</th>
          </tr>
        </tfoot>
      </table>
    </div>
  `;
}

function sheetRow({ label, rowKey, projectId, leaveType, visibleDays, totalDays, entryMap, rowClass = '' }) {
  const rowTotal = totalDays.reduce((sum, day) => {
    const entry = entryMap.get(`${rowKey}-${day}`);
    return sum + Number(entry?.hours || 0);
  }, 0);

  return `
    <tr class="${rowClass}">
      <th class="project-column">${escapeHtml(label)}</th>
      ${visibleDays.map((day) => {
        const entry = entryMap.get(`${rowKey}-${day}`);
        const value = entry?.hours ? String(entry.hours).replace(/\.00$/, '') : '';
        const isOutsideMonth = !day.startsWith(timePeriod);
        return `
          <td class="${dayClass(day)}">
            <input
              class="hours-cell"
              inputmode="decimal"
              data-project-id="${projectId}"
              data-leave-type="${leaveType}"
              data-entry-date="${day}"
              value="${escapeHtml(value)}"
              aria-label="${escapeHtml(label)} ${day}"
              ${isOutsideMonth ? 'disabled' : ''}
            />
          </td>
        `;
      }).join('')}
      <td class="row-total">${rowTotal ? rowTotal.toFixed(2) : ''}</td>
    </tr>
  `;
}

function entryKey(entry) {
  return `${entry.leave_type || entry.project_id}-${entry.entry_date}`;
}

function dayClass(day) {
  return [
    day.startsWith(timePeriod) ? '' : 'outside-month',
    isWeekend(day) ? 'weekend' : '',
  ].filter(Boolean).join(' ');
}

async function saveGridChanges() {
  const message = document.querySelector('#entry-message');
  const saveButton = document.querySelector('#save-grid-button');
  const changedCells = Array.from(document.querySelectorAll('.hours-cell[data-changed="true"]'));

  message.classList.add('hidden');
  saveButton.disabled = true;
  saveButton.textContent = 'Saving...';

  for (const cell of changedCells) {
    const { error } = await supabaseClient.rpc('save_grid_hours', {
      p_project_id: cell.dataset.projectId,
      p_entry_date: cell.dataset.entryDate,
      p_hours_text: cell.value.trim(),
      p_notes: '',
      p_leave_type: cell.dataset.leaveType || null,
    });

    if (error) {
      showMessage(message, friendlyDatabaseError(error), true);
      saveButton.disabled = false;
      saveButton.textContent = 'Save changes';
      return;
    }
  }

  showToast('Hours saved.');
  hasUnsavedHours = false;
  renderTimeTracking();
}

function confirmDiscardUnsavedChanges() {
  if (!hasUnsavedHours) return true;

  const shouldDiscard = confirm('You have unsaved hours. If you continue, those changes will be lost. Continue?');
  if (shouldDiscard) hasUnsavedHours = false;
  return shouldDiscard;
}

async function renderReports() {
  const content = document.querySelector('#tab-content');
  const selectedMonth = content.dataset.month || thisMonth;
  const startDate = `${selectedMonth}-01`;
  const endDate = lastDayOfMonth(selectedMonth);
  const isManager = currentProfile.role === 'manager';

  let employeesQuery = supabaseClient.from('profiles').select('*').order('full_name');
  let entriesQuery = supabaseClient
    .from('time_entries')
    .select('employee_id, project_id, hours, leave_type')
    .gte('entry_date', startDate)
    .lte('entry_date', endDate);

  if (!isManager) {
    employeesQuery = employeesQuery.eq('id', getSessionUserId());
    entriesQuery = entriesQuery.eq('employee_id', getSessionUserId());
  }

  const [{ data: employees }, { data: projects }, { data: entries }] = await Promise.all([
    employeesQuery,
    supabaseClient.from('projects').select('*').order('name'),
    entriesQuery,
  ]);
  const reportData = buildMonthlyReportData(employees || [], projects || [], entries || []);

  content.innerHTML = `
    <section class="panel">
      <div class="panel-header">
        <div>
          <h2>Report ${monthLabel(selectedMonth)}</h2>
          <p class="muted">${reportData.hoursTotal.toFixed(2)} total hours · €${reportData.capexTotal.toFixed(2)} CAPEX</p>
        </div>
        <div class="actions">
          <input id="report-month" type="month" value="${selectedMonth}" />
          <button class="secondary-button" id="export-report-button">Export Excel</button>
        </div>
      </div>
      <div class="report-stack">
        <section>
          <h3>Hours</h3>
          ${monthlyMatrixTable(reportData.hoursRows, reportData.employees, 'hours')}
        </section>
        <section>
          <h3>CAPEX</h3>
          ${monthlyMatrixTable(reportData.capexRows, reportData.employees, 'money')}
        </section>
      </div>
    </section>
  `;

  document.querySelector('#report-month').addEventListener('change', (event) => {
    content.dataset.month = event.target.value;
    renderReports();
  });

  document.querySelector('#export-report-button').addEventListener('click', () => exportMonthlyWorkbook(reportData, selectedMonth));
}

function buildMonthlyReportData(employees, projects, entries) {
  const projectEntries = entries.filter((entry) => entry.project_id);
  const employeeMap = new Map(employees.map((employee) => [employee.id, employee]));
  const projectRows = projects.map((project) => {
    const values = {};

    employees.forEach((employee) => {
      values[employee.id] = projectEntries
        .filter((entry) => entry.project_id === project.id && entry.employee_id === employee.id)
        .reduce((sum, entry) => sum + Number(entry.hours || 0), 0);
    });

    return {
      project,
      values,
      total: Object.values(values).reduce((sum, value) => sum + value, 0),
    };
  });

  const hoursRows = projectRows.filter((row) => row.total > 0 || row.project.is_active);
  const capexRows = hoursRows
    .filter((row) => row.project.activate_hours)
    .map((row) => {
      const values = {};

      employees.forEach((employee) => {
        const rate = Number(employeeMap.get(employee.id)?.hourly_rate_eur || 0);
        values[employee.id] = Number(row.values[employee.id] || 0) * rate;
      });

      return {
        project: row.project,
        values,
        total: Object.values(values).reduce((sum, value) => sum + value, 0),
      };
    });

  return {
    employees,
    hoursRows,
    capexRows,
    hoursTotal: hoursRows.reduce((sum, row) => sum + row.total, 0),
    capexTotal: capexRows.reduce((sum, row) => sum + row.total, 0),
  };
}

function monthlyMatrixTable(rows, employees, type) {
  if (!rows.length) return '<p class="empty-state">No records yet.</p>';

  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Project</th>
            <th>Projectcode</th>
            <th>Activate hours</th>
            ${employees.map((employee) => `<th>${escapeHtml(employee.full_name || employee.email)}</th>`).join('')}
            <th>Total</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((row) => `
            <tr>
              <td>${escapeHtml(row.project.name)}</td>
              <td>${escapeHtml(row.project.project_code || '')}</td>
              <td>${row.project.activate_hours ? 'Yes' : 'No'}</td>
              ${employees.map((employee) => `<td>${formatReportValue(row.values[employee.id], type)}</td>`).join('')}
              <td>${formatReportValue(row.total, type)}</td>
            </tr>
          `).join('')}
        </tbody>
        <tfoot>
          <tr>
            <th colspan="3">Total</th>
            ${employees.map((employee) => {
              const total = rows.reduce((sum, row) => sum + Number(row.values[employee.id] || 0), 0);
              return `<th>${formatReportValue(total, type)}</th>`;
            }).join('')}
            <th>${formatReportValue(rows.reduce((sum, row) => sum + row.total, 0), type)}</th>
          </tr>
        </tfoot>
      </table>
    </div>
  `;
}

function formatReportValue(value, type) {
  const number = Number(value || 0);
  if (!number) return '';
  return type === 'money' ? `€${number.toFixed(2)}` : number.toFixed(2);
}

async function renderEmployees() {
  const content = document.querySelector('#tab-content');
  const { data } = await supabaseClient.from('profiles').select('*').order('full_name');
  const employees = data || [];

  content.innerHTML = `
    <section class="panel">
      <h2>Employees</h2>
      ${employeesTable(employees)}
    </section>
  `;

  document.querySelectorAll('[data-employee-save]').forEach((button) => {
    button.addEventListener('click', async () => {
      const id = button.dataset.employeeSave;
      const role = document.querySelector(`[data-role-user="${id}"]`).value;
      const hours = document.querySelector(`[data-working-hours="${id}"]`).value;
      const rate = document.querySelector(`[data-hourly-rate="${id}"]`).value;
      const { error } = await supabaseClient.rpc('save_employee_settings', {
        p_employee_id: id,
        p_role: role,
        p_working_hours_text: hours,
        p_hourly_rate_text: rate,
      });

      if (error) {
        showToast(errorText(error));
        return;
      }

      showToast('Employee saved.');
      renderEmployees();
    });
  });
}

async function renderProjects() {
  const content = document.querySelector('#tab-content');
  const { data } = await supabaseClient.from('projects').select('*').order('name');
  const projects = data || [];

  content.innerHTML = `
    <section class="panel">
      <div class="panel-header">
        <h2>Projects</h2>
        <form class="inline-form" id="project-form">
          <input id="project-name" placeholder="New project name" required />
          <input id="project-code" placeholder="Project code" />
          <button class="primary-button" type="submit">Add</button>
        </form>
      </div>
      ${projectsTable(projects)}
    </section>
  `;

  document.querySelector('#project-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    await supabaseClient.from('projects').insert({
      name: document.querySelector('#project-name').value.trim(),
      project_code: document.querySelector('#project-code').value.trim(),
      activate_hours: true,
    });
    renderProjects();
  });

  document.querySelectorAll('[data-project-save]').forEach((button) => {
    button.addEventListener('click', async () => {
      const input = document.querySelector(`[data-project-name="${button.dataset.projectSave}"]`);
      const codeInput = document.querySelector(`[data-project-code="${button.dataset.projectSave}"]`);
      const hoursSelect = document.querySelector(`[data-project-hours="${button.dataset.projectSave}"]`);
      const newName = input.value.trim();

      if (!newName) {
        showToast('Project name cannot be empty.');
        return;
      }

      const { error } = await supabaseClient
        .from('projects')
        .update({
          name: newName,
          project_code: codeInput.value.trim(),
          activate_hours: hoursSelect.value === 'true',
        })
        .eq('id', button.dataset.projectSave);

      if (error) {
        showToast(errorText(error));
        return;
      }

      showToast('Project name saved.');
      renderProjects();
    });
  });

  document.querySelectorAll('[data-project-delete]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (!confirm('Delete this project? If hours were already logged on it, Supabase may block the delete to protect the history.')) {
        return;
      }

      const { error } = await supabaseClient
        .from('projects')
        .delete()
        .eq('id', button.dataset.projectDelete);

      if (error) {
        showToast(errorText(error));
        return;
      }

      showToast('Project deleted.');
      renderProjects();
    });
  });

  document.querySelectorAll('[data-project-toggle]').forEach((button) => {
    button.addEventListener('click', async () => {
      await supabaseClient
        .from('projects')
        .update({ is_active: button.dataset.active !== 'true' })
        .eq('id', button.dataset.projectToggle);
      renderProjects();
    });
  });
}

function timeEntriesTable(rows) {
  return basicTable(['Date', 'Project', 'Hours', 'Notes'], rows.map((row) => [
    row.entry_date,
    row.projects?.name,
    row.hours,
    row.notes || '',
  ]));
}

function reportTable(rows) {
  return basicTable(['Date', 'Employee', 'Project', 'Hours', 'Notes'], rows.map((row) => [
    row.entry_date,
    row.profiles?.full_name || row.profiles?.email || '',
    entryProjectLabel(row),
    row.hours,
    row.notes || '',
  ]));
}

function entryProjectLabel(row) {
  if (row.leave_type === 'sick') return 'Sick leave';
  if (row.leave_type === 'holiday') return 'Holiday leave';
  return row.projects?.name || '';
}

function employeesTable(rows) {
  return `
    <div class="table-wrap">
      <table>
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Hours/week</th><th>Hourly rate (€)</th><th>Action</th></tr></thead>
        <tbody>
          ${rows.map((row) => `
            <tr>
              <td>${escapeHtml(row.full_name || '')}</td>
              <td>${escapeHtml(row.email || '')}</td>
              <td>
                <select data-role-user="${row.id}">
                  <option value="employee" ${row.role === 'employee' ? 'selected' : ''}>employee</option>
                  <option value="manager" ${row.role === 'manager' ? 'selected' : ''}>manager</option>
                </select>
              </td>
              <td>
                <input
                  class="working-hours-input"
                  data-working-hours="${row.id}"
                  type="number"
                  min="0"
                  max="80"
                  step="0.25"
                  value="${row.working_hours_per_week ?? 40}"
                />
              </td>
              <td>
                <input
                  class="hourly-rate-input"
                  data-hourly-rate="${row.id}"
                  type="number"
                  min="0"
                  step="0.01"
                  value="${row.hourly_rate_eur ?? 0}"
                />
              </td>
              <td><button class="text-button" data-employee-save="${row.id}">Save</button></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function projectsTable(rows) {
  return `
    <div class="table-wrap">
      <table>
        <thead><tr><th>Project</th><th>Code</th><th>Activate hours</th><th>Status</th><th>Action</th></tr></thead>
        <tbody>
          ${rows.map((row) => `
            <tr>
              <td><input class="project-name-input" data-project-name="${row.id}" value="${escapeHtml(row.name)}" /></td>
              <td><input class="project-code-input" data-project-code="${row.id}" value="${escapeHtml(row.project_code || '')}" /></td>
              <td>
                <select data-project-hours="${row.id}">
                  <option value="true" ${row.activate_hours ? 'selected' : ''}>Yes</option>
                  <option value="false" ${row.activate_hours ? '' : 'selected'}>No</option>
                </select>
              </td>
              <td>${row.is_active ? 'Active' : 'Inactive'}</td>
              <td>
                <button class="text-button" data-project-save="${row.id}">Save</button>
                <button class="text-button" data-project-toggle="${row.id}" data-active="${row.is_active}">
                  ${row.is_active ? 'Deactivate' : 'Activate'}
                </button>
                <button class="text-button danger-text" data-project-delete="${row.id}">Delete</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function basicTable(headers, rows) {
  if (!rows.length) return '<p class="empty-state">No records yet.</p>';

  return `
    <div class="table-wrap">
      <table>
        <thead><tr>${headers.map((header) => `<th>${header}</th>`).join('')}</tr></thead>
        <tbody>
          ${rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(String(cell ?? ''))}</td>`).join('')}</tr>`).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function exportExcel(rows, month) {
  const worksheetRows = [
    ['Date', 'Employee', 'Project', 'Hours', 'Notes'],
    ...rows.map((row) => [
      row.entry_date,
      row.profiles?.full_name || row.profiles?.email || '',
      entryProjectLabel(row),
      Number(row.hours || 0),
      row.notes || '',
    ]),
  ];

  downloadExcelWorkbook(`time-report-${month}.xlsx`, [{ name: 'Monthly report', rows: worksheetRows }]);
}

function monthlyMatrixRows(rows, employees) {
  return [
    [
      'Project',
      'Projectcode',
      'Activate hours',
      ...employees.map((employee) => employee.full_name || employee.email),
      'Total',
    ],
    ...rows.map((row) => [
      row.project.name,
      row.project.project_code || '',
      row.project.activate_hours ? 'Yes' : 'No',
      ...employees.map((employee) => Number(row.values[employee.id] || 0)),
      Number(row.total || 0),
    ]),
    [
      'Total',
      '',
      '',
      ...employees.map((employee) => rows.reduce((sum, row) => sum + Number(row.values[employee.id] || 0), 0)),
      rows.reduce((sum, row) => sum + Number(row.total || 0), 0),
    ],
  ];
}

function exportMonthlyWorkbook(reportData, month) {
  const sheets = [
    { name: 'CAPEX', rows: monthlyMatrixRows(reportData.capexRows, reportData.employees) },
    { name: 'Hours', rows: monthlyMatrixRows(reportData.hoursRows, reportData.employees) },
  ];

  downloadExcelWorkbook(`M&I-monthly-report-${monthLabel(month).replace(' ', '-')}.xlsx`, sheets);
}

function downloadExcelWorkbook(filename, sheets) {
  const files = buildXlsxFiles(sheets);
  const blob = new Blob([zipFiles(files)], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}

function buildXlsxFiles(sheets) {
  const safeSheets = sheets.map((sheet, index) => ({
    name: sanitizeSheetName(sheet.name || `Sheet ${index + 1}`),
    rows: sheet.rows,
  }));
  const sheetOverrides = safeSheets.map((_sheet, index) => (
    `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
  )).join('');
  const workbookSheets = safeSheets.map((sheet, index) => (
    `<sheet name="${xmlEscape(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`
  )).join('');
  const workbookRels = safeSheets.map((_sheet, index) => (
    `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`
  )).join('');
  const stylesRelId = `rId${safeSheets.length + 1}`;

  const files = [
    {
      name: '[Content_Types].xml',
      content: `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  ${sheetOverrides}
</Types>`,
    },
    {
      name: '_rels/.rels',
      content: `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
    },
    {
      name: 'xl/workbook.xml',
      content: `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>${workbookSheets}</sheets>
</workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      content: `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${workbookRels}
  <Relationship Id="${stylesRelId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
    },
    {
      name: 'xl/styles.xml',
      content: `<?xml version="1.0" encoding="UTF-8"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2">
    <font><sz val="11"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><name val="Calibri"/></font>
  </fonts>
  <fills count="1"><fill><patternFill patternType="none"/></fill></fills>
  <borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="2">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
  </cellXfs>
</styleSheet>`,
    },
    ...safeSheets.map((sheet, index) => ({
      name: `xl/worksheets/sheet${index + 1}.xml`,
      content: buildWorksheetXml(sheet.rows),
    })),
  ];

  return files;
}

function buildWorksheetXml(rows) {
  const sheetRows = rows.map((row, rowIndex) => {
    const cells = row.map((value, columnIndex) => {
      const reference = `${columnName(columnIndex + 1)}${rowIndex + 1}`;
      const isNumber = typeof value === 'number' && Number.isFinite(value);
      const style = rowIndex === 0 ? ' s="1"' : '';

      if (isNumber) {
        return `<c r="${reference}"${style}><v>${value.toFixed(2)}</v></c>`;
      }

      return `<c r="${reference}" t="inlineStr"${style}><is><t>${xmlEscape(String(value ?? ''))}</t></is></c>`;
    }).join('');

    return `<row r="${rowIndex + 1}">${cells}</row>`;
  }).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>${sheetRows}</sheetData>
</worksheet>`;
}

function columnName(number) {
  let name = '';
  let value = number;

  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }

  return name;
}

function sanitizeSheetName(name) {
  return name.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Sheet';
}

function zipFiles(files) {
  const encoder = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  files.forEach((file) => {
    const nameBytes = encoder.encode(file.name);
    const data = encoder.encode(file.content);
    const crc = crc32(data);
    const localHeader = zipLocalHeader(nameBytes, data, crc);
    const centralHeader = zipCentralHeader(nameBytes, data, crc, offset);

    localParts.push(localHeader, data);
    centralParts.push(centralHeader);
    offset += localHeader.length + data.length;
  });

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = zipEndRecord(files.length, centralSize, offset);
  return concatBytes([...localParts, ...centralParts, end]);
}

function zipLocalHeader(nameBytes, data, crc) {
  const header = new Uint8Array(30 + nameBytes.length);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 0x0800, true);
  view.setUint16(8, 0, true);
  view.setUint16(10, 0, true);
  view.setUint16(12, 0, true);
  view.setUint32(14, crc, true);
  view.setUint32(18, data.length, true);
  view.setUint32(22, data.length, true);
  view.setUint16(26, nameBytes.length, true);
  header.set(nameBytes, 30);
  return header;
}

function zipCentralHeader(nameBytes, data, crc, offset) {
  const header = new Uint8Array(46 + nameBytes.length);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x02014b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 20, true);
  view.setUint16(8, 0x0800, true);
  view.setUint16(10, 0, true);
  view.setUint16(12, 0, true);
  view.setUint16(14, 0, true);
  view.setUint32(16, crc, true);
  view.setUint32(20, data.length, true);
  view.setUint32(24, data.length, true);
  view.setUint16(28, nameBytes.length, true);
  view.setUint32(42, offset, true);
  header.set(nameBytes, 46);
  return header;
}

function zipEndRecord(fileCount, centralSize, centralOffset) {
  const end = new Uint8Array(22);
  const view = new DataView(end.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, fileCount, true);
  view.setUint16(10, fileCount, true);
  view.setUint32(12, centralSize, true);
  view.setUint32(16, centralOffset, true);
  return end;
}

function concatBytes(parts) {
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(totalLength);
  let offset = 0;

  parts.forEach((part) => {
    output.set(part, offset);
    offset += part.length;
  });

  return output;
}

function crc32(bytes) {
  let crc = 0xffffffff;

  for (const byte of bytes) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  }

  return (crc ^ 0xffffffff) >>> 0;
}

const crcTable = Array.from({ length: 256 }, (_value, index) => {
  let crc = index;

  for (let bit = 0; bit < 8; bit += 1) {
    crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }

  return crc >>> 0;
});

function xmlEscape(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function showMessage(element, text, isError = false) {
  element.textContent = text;
  element.classList.toggle('error', isError);
  element.classList.remove('hidden');
}

function errorText(error) {
  if (!error) return '';
  if (typeof error === 'string') return error;
  return error.message || String(error);
}

function showToast(text) {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = text;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 2600);
}

function friendlyDatabaseError(error) {
  if (error.includes('Could not find the function')) {
    return 'Supabase needs the updated database script. Open SQL Editor, run supabase/schema.sql again, then refresh this app.';
  }

  if (error.includes('violates row-level security')) {
    const userId = getSessionUserId();
    return `Supabase blocked this save. Log out and log back in, then try again. User ID used: ${userId || 'not found'}.`;
  }

  if (error.includes('foreign key constraint') || error.includes('invalid input syntax')) {
    return 'The selected project could not be found. Ask a manager to check the projects list.';
  }

  if (error.includes('hours') || error.includes('check constraint')) {
    return 'Hours must be more than 0 and no more than 24.';
  }

  return error;
}

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function getSessionUserId() {
  return currentSession?.user?.id || getJwtPayload(currentSession?.access_token)?.sub || null;
}

function getJwtPayload(token) {
  if (!token) return null;

  try {
    const payload = token.split('.')[1];
    const decoded = atob(payload.replaceAll('-', '+').replaceAll('_', '/'));
    return JSON.parse(decoded);
  } catch (_error) {
    return null;
  }
}

function createSimpleClient(baseUrl, anonKey) {
  const cleanUrl = baseUrl.replace(/\/$/, '');
  let session = JSON.parse(localStorage.getItem('time_tracker_session') || 'null');
  let authCallback = null;

  function authHeaders() {
    return {
      apikey: anonKey,
      Authorization: `Bearer ${session?.access_token || anonKey}`,
      'Content-Type': 'application/json',
    };
  }

  async function request(url, options = {}) {
    let response;
    let data = null;

    try {
      response = await fetch(url, options);
      const text = await response.text();
      data = text ? JSON.parse(text) : null;
    } catch (_error) {
      return { data: null, error: 'The browser could not reach Supabase. Check your internet connection or try opening the app from a temporary website link instead of double-clicking the file.' };
    }

    if (!response.ok) {
      return { data: null, error: data?.error_description || data?.message || 'Request failed' };
    }

    return { data, error: null };
  }

  return {
    auth: {
      async getSession() {
        return { data: { session } };
      },
      onAuthStateChange(callback) {
        authCallback = callback;
        return { data: { subscription: { unsubscribe() {} } } };
      },
      async signUp({ email, password, options }) {
        const result = await request(`${cleanUrl}/auth/v1/signup`, {
          method: 'POST',
          headers: { apikey: anonKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email,
            password,
            data: options?.data || {},
          }),
        });

        if (!result.error && result.data?.session) {
          session = result.data.session;
          localStorage.setItem('time_tracker_session', JSON.stringify(session));
          authCallback?.('SIGNED_IN', session);
        }

        return { error: result.error };
      },
      async signInWithPassword({ email, password }) {
        const result = await request(`${cleanUrl}/auth/v1/token?grant_type=password`, {
          method: 'POST',
          headers: { apikey: anonKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password }),
        });

        if (!result.error) {
          session = result.data;
          localStorage.setItem('time_tracker_session', JSON.stringify(session));
          authCallback?.('SIGNED_IN', session);
        }

        return { error: result.error };
      },
      async signOut() {
        session = null;
        localStorage.removeItem('time_tracker_session');
        authCallback?.('SIGNED_OUT', null);
      },
    },
    rpc(functionName, values) {
      return rpcRequest(cleanUrl, anonKey, session, functionName, values);
    },
    from(table) {
      return new QueryBuilder(cleanUrl, anonKey, () => session, table);
    },
  };
}

async function rpcRequest(baseUrl, anonKey, session, functionName, values) {
  let response;
  let data = null;

  try {
    response = await fetch(`${baseUrl}/rest/v1/rpc/${functionName}`, {
      method: 'POST',
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${session?.access_token || anonKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(values),
    });

    const text = await response.text();
    data = text ? JSON.parse(text) : null;
  } catch (_error) {
    return { data: null, error: 'The browser could not reach Supabase. Check your internet connection or try opening the app from a temporary website link instead of double-clicking the file.' };
  }

  if (!response.ok) {
    return { data: null, error: data?.message || 'Request failed' };
  }

  return { data, error: null };
}

class QueryBuilder {
  constructor(baseUrl, anonKey, getSession, table) {
    this.baseUrl = baseUrl;
    this.anonKey = anonKey;
    this.getSession = getSession;
    this.table = table;
    this.params = new URLSearchParams();
    this.method = 'GET';
    this.body = null;
    this.expectSingle = false;
  }

  select(columns = '*') {
    this.params.set('select', columns);
    return this;
  }

  eq(column, value) {
    this.params.set(column, `eq.${value}`);
    return this;
  }

  gte(column, value) {
    this.params.set(column, `gte.${value}`);
    return this;
  }

  lte(column, value) {
    this.params.set(column, `lte.${value}`);
    return this;
  }

  order(column, options = {}) {
    this.params.set('order', `${column}.${options.ascending === false ? 'desc' : 'asc'}`);
    return this;
  }

  single() {
    this.expectSingle = true;
    return this;
  }

  insert(values) {
    this.method = 'POST';
    this.body = values;
    return this.execute();
  }

  update(values) {
    this.method = 'PATCH';
    this.body = values;
    return this;
  }

  delete() {
    this.method = 'DELETE';
    return this;
  }

  then(resolve, reject) {
    return this.execute().then(resolve, reject);
  }

  async execute() {
    const url = `${this.baseUrl}/rest/v1/${this.table}?${this.params.toString()}`;
    const session = this.getSession();
    const headers = {
      apikey: this.anonKey,
      Authorization: `Bearer ${session?.access_token || this.anonKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    };

    let response;
    let data = null;

    try {
      response = await fetch(url, {
        method: this.method,
        headers,
        body: this.body ? JSON.stringify(this.body) : null,
      });

      const text = await response.text();
      data = text ? JSON.parse(text) : null;
    } catch (_error) {
      return { data: null, error: 'The browser could not reach Supabase. Check your internet connection or try opening the app from a temporary website link instead of double-clicking the file.' };
    }

    if (!response.ok) {
      return { data: null, error: data?.message || 'Request failed' };
    }

    return { data: this.expectSingle ? data?.[0] || null : data, error: null };
  }
}

startApp();
