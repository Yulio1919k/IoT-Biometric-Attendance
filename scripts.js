// ============================================
// CONFIGURACIÓN OPTIMIZADA PARA ESP32
// ============================================
const CONFIG = {
  API_BASE: '',
  CAPTURE_TIMEOUT: 30000,
  CAPTURE_INTERVAL: 1500,
  ATTENDANCE_INTERVAL: 4000,
  STATUS_CHECK_INTERVAL: 20000,
  NOTIFICATION_DURATION: 3500,
  REQUEST_TIMEOUT: 10000,
  MAX_RETRIES: 2,
  MAX_CONCURRENT_REQUESTS: 2
};

// ============================================
// ESTADO GLOBAL
// ============================================
const State = {
  intervals: {
    capture: null,
    attendance: null,
    status: null
  },
  data: {
    full: [],
    users: [],
    filtered: []
  },
  flags: {
    captureActive: false,
    dbLoading: false,
    usersLoading: false
  },
  requests: {
    pending: 0,
    queue: []
  }
};

// ============================================
// GESTOR DE REQUESTS (EVITA SOBRECARGA)
// ============================================
const RequestManager = {
  async execute(fn) {
    while (State.requests.pending >= CONFIG.MAX_CONCURRENT_REQUESTS) {
      await new Promise(r => setTimeout(r, 100));
    }
    
    State.requests.pending++;
    try {
      return await fn();
    } finally {
      State.requests.pending--;
    }
  }
};

// ============================================
// API OPTIMIZADA CON VALIDACIÓN DE NOMBRES
// ============================================
const API = {
  async request(endpoint, options = {}, retries = 0) {
    return RequestManager.execute(async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT);

      try {
        const response = await fetch(`${CONFIG.API_BASE}${endpoint}`, {
          ...options,
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            ...options.headers
          }
        });

        clearTimeout(timeoutId);
        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.message || data.error || `Error ${response.status}`);
        }

        return { data, status: response.status };

      } catch (error) {
        clearTimeout(timeoutId);

        if (error.name === 'AbortError' && retries < CONFIG.MAX_RETRIES) {
          console.log(`Reintento ${retries + 1}/${CONFIG.MAX_RETRIES} en ${endpoint}`);
          await new Promise(r => setTimeout(r, 1000));
          return this.request(endpoint, options, retries + 1);
        }

        throw error;
      }
    });
  },

  getNextId: () => API.request('/api/next-id'),
  getSystemStatus: () => API.request('/api/system-status'),
  startFingerprint: () => API.request('/api/fingerprint/start'),
  registerUser: (data) => API.request('/api/register', { method: 'POST', body: JSON.stringify(data) }),
  checkAttendance: () => API.request('/api/attendance'),
  getDatabase: () => API.request('/api/database'),
  getUsers: () => API.request('/api/users'),
  editUser: (data) => API.request('/api/edit-user', { method: 'POST', body: JSON.stringify(data) }),
  deleteUser: (id) => API.request('/api/delete-user', { method: 'POST', body: JSON.stringify({ id }) }),
  checkName: (name) => API.request('/api/check-name', { method: 'POST', body: JSON.stringify({ name }) })
};

// ============================================
// UTILIDADES
// ============================================
const Utils = {
  formatDate(date) {
    return new Date(date).toLocaleDateString('es-ES', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
  },

  formatTime(time) {
    return time || '---';
  },

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  },

  debounce(func, wait) {
    let timeout;
    return function(...args) {
      clearTimeout(timeout);
      timeout = setTimeout(() => func.apply(this, args), wait);
    };
  },

  getElement(id) {
    return document.getElementById(id);
  },

  setContent(id, content) {
    const el = this.getElement(id);
    if (el) el.textContent = content;
  },

  setHTML(id, html) {
    const el = this.getElement(id);
    if (el) el.innerHTML = html;
  }
};

// ============================================
// NOTIFICACIONES
// ============================================
const Notification = {
  show(message, type = 'info') {
    const box = Utils.getElement('notification');
    const text = Utils.getElement('notification-message');

    if (!box || !text) return;

    text.textContent = message;
    box.style.borderLeftColor = this.getColor(type);
    box.classList.add('show');

    setTimeout(() => {
      box.classList.remove('show');
    }, CONFIG.NOTIFICATION_DURATION);
  },

  getColor(type) {
    const colors = {
      success: '#28a745',
      error: '#dc3545',
      warning: '#ffc107',
      info: '#667eea'
    };
    return colors[type] || colors.info;
  }
};

// ============================================
// GESTOR DE INTERVALOS
// ============================================
const IntervalManager = {
  clear(name) {
    if (State.intervals[name]) {
      clearInterval(State.intervals[name]);
      State.intervals[name] = null;
    }
  },

  clearAll() {
    Object.keys(State.intervals).forEach(key => this.clear(key));
  },

  set(name, callback, interval) {
    this.clear(name);
    State.intervals[name] = setInterval(callback, interval);
  }
};

// ============================================
// NAVEGACIÓN
// ============================================
const Navigation = {
  init() {
    document.querySelectorAll('.nav-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const tab = e.target.dataset.tab;
        if (tab) this.switchTab(tab);
      });
    });
  },

  switchTab(tabName) {
    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));

    const section = Utils.getElement(tabName);
    if (section) section.classList.add('active');

    const btn = document.querySelector(`[data-tab="${tabName}"]`);
    if (btn) btn.classList.add('active');

    const actions = {
      usuarios: () => Users.load(),
      reportes: () => Database.load(),
      registro: () => Fingerprint.showNextID()
    };

    if (actions[tabName]) actions[tabName]();
  }
};

// ============================================
// ESTADO DEL SISTEMA
// ============================================
const SystemStatus = {
  async check() {
    try {
      const { data } = await API.getSystemStatus();

      this.updatePill('esp32', data.esp32 ? 'success' : 'error',
        data.esp32 ? 'Conectado' : 'Desconectado');

      this.updatePill('sensor', data.sensor ? 'success' : 'error',
        data.sensor ? 'OK' : 'Error');

      this.updatePill('rtc', data.rtc ? 'success' : 'warning',
        data.rtc ? 'OK' : 'Sin RTC');

    } catch (error) {
      this.updatePill('esp32', 'error', 'Sin conexión');
      this.updatePill('sensor', 'error', '---');
      this.updatePill('rtc', 'error', '---');
    }
  },

  updatePill(device, status, text) {
    const pill = Utils.getElement(`status-${device}`);
    const statusText = Utils.getElement(`${device}-status`);

    if (!pill || !statusText) return;

    pill.className = `pill ${status}`;
    statusText.textContent = text;
  },

  startMonitoring() {
    this.check();
    IntervalManager.set('status', () => this.check(), CONFIG.STATUS_CHECK_INTERVAL);
  }
};


// ============================================
// VALIDACIÓN DE NOMBRE EN TIEMPO REAL
// ============================================
const NameValidator = {
  timeout: null,
  lastChecked: '',
  
  async check(name) {
    name = name.trim();
    
    const input = Utils.getElement('userName');
    const feedback = Utils.getElement('name-feedback');
    
    if (!input || !feedback) return;
    
    // Resetear estilos
    input.style.borderColor = '';
    feedback.textContent = '';
    feedback.className = 'input-feedback';
    
    // Validación mínima
    if (name.length < 3) {
      if (name.length > 0) {
        feedback.textContent = 'Mínimo 3 caracteres';
        feedback.className = 'input-feedback warning';
      }
      return;
    }
    
    // No verificar si ya se chequeó este nombre
    if (name === this.lastChecked) return;
    this.lastChecked = name;
    
    // Mostrar verificando
    feedback.textContent = 'Verificando...';
    feedback.className = 'input-feedback info';
    
    try {
      const { data } = await API.checkName(name);
      
      if (data.exists) {
        input.style.borderColor = '#dc3545';
        feedback.textContent = '❌ Este nombre ya está registrado';
        feedback.className = 'input-feedback error';
        
        // Deshabilitar botón de registro
        const registerBtn = Utils.getElement('registerBtn');
        if (registerBtn) {
          registerBtn.disabled = true;
          registerBtn.title = 'Este nombre ya existe';
        }
      } else {
        input.style.borderColor = '#28a745';
        feedback.textContent = '✓ Nombre disponible';
        feedback.className = 'input-feedback success';
        
        // Habilitar botón de registro
        const registerBtn = Utils.getElement('registerBtn');
        if (registerBtn) {
          registerBtn.disabled = false;
          registerBtn.title = '';
        }
      }
    } catch (error) {
      console.error('Error verificando nombre:', error);
      feedback.textContent = '';
      input.style.borderColor = '';
    }
  },
  
  debounced(name) {
    clearTimeout(this.timeout);
    this.timeout = setTimeout(() => this.check(name), 500);
  },
  
  reset() {
    this.lastChecked = '';
    const input = Utils.getElement('userName');
    const feedback = Utils.getElement('name-feedback');
    
    if (input) input.style.borderColor = '';
    if (feedback) {
      feedback.textContent = '';
      feedback.className = 'input-feedback';
    }
  }
};

// ============================================
// CAPTURA DE HUELLA
// ============================================
// ============================================
// CAPTURA DE HUELLA CON DETECCIÓN DE DUPLICADOS
// ============================================
const Fingerprint = {
  state: {
    attempts: 0,
    maxAttempts: Math.floor(CONFIG.CAPTURE_TIMEOUT / CONFIG.CAPTURE_INTERVAL)
  },

  async showNextID() {
    try {
      const { data } = await API.getNextId();
      const input = Utils.getElement('fingerprintId');
      if (input) {
        input.placeholder = `Siguiente ID: ${data.nextId}`;
      }
    } catch (error) {
      console.error('Error obteniendo siguiente ID:', error);
    }
  },

  async start() {
    if (State.flags.captureActive) {
      Notification.show('Ya hay una captura en proceso', 'warning');
      return;
    }

    IntervalManager.clear('attendance');
    State.flags.captureActive = true;

    try {
      const { data: idData } = await API.getNextId();
      const nextID = idData.nextId;
      Utils.getElement('fingerprintId').value = nextID;
      Notification.show(`Siguiente ID disponible: ${nextID}`, 'info');
    } catch (error) {
      console.error('Error obteniendo siguiente ID:', error);
    }

    this.updateUI('Iniciando captura...', false, true);
    this.state.attempts = 0;

    IntervalManager.set('capture', () => this.captureStep(), CONFIG.CAPTURE_INTERVAL);
  },

  async captureStep() {
    this.state.attempts++;

    if (this.state.attempts > this.state.maxAttempts) {
      this.stop('Tiempo agotado. Intente nuevamente.');
      Notification.show('Tiempo de captura agotado', 'warning');
      Attendance.startMonitoring();
      return;
    }

    try {
      const response = await fetch('/api/fingerprint/start');
      const data = await response.json();

      // ⭐ DETECTAR HUELLA DUPLICADA (código 409 o step -1)
      if (response.status === 409 || data.step === -1) {
        this.stop('❌ Esta huella ya está registrada');
        
        const mensaje = data.nombre ? 
          `Esta huella pertenece a: ${data.nombre} (ID: ${data.id})` :
          'Esta huella ya está registrada en el sistema';
        
        Notification.show(mensaje, 'error');
        
        // Mostrar mensaje de error más prominente
        const status = Utils.getElement('fingerprint-status');
        if (status) {
          status.innerHTML = `
            <div style="color:#dc3545;font-weight:700;margin-bottom:10px">
              ❌ Huella Duplicada
            </div>
            <div style="color:#6c757d;font-size:0.9em">
              ${mensaje}
            </div>
          `;
        }
        
        // Reiniciar después de 4 segundos
        setTimeout(() => {
          this.resetForm();
          Attendance.startMonitoring();
        }, 4000);
        
        return;
      }

      if (data.step === 0) {
        this.updateUI('Coloque el dedo en el sensor...', false, true);
      } else if (data.step === 1) {
        this.updateUI('Primera lectura OK. Retire el dedo...', true, true);
        Notification.show('Primera lectura completada', 'success');
      } else if (data.step === 2 && data.id) {
        this.stop(`Huella capturada correctamente! ID: ${data.id}`);
        Utils.getElement('fingerprintId').value = data.id;
        this.showRegisterButton();
        Notification.show(`Huella capturada - ID: ${data.id}`, 'success');
        setTimeout(() => Attendance.startMonitoring(), 2000);
      }
    } catch (error) {
      // Silencioso - requests normales sin huella
    }
  },

  stop(message) {
    IntervalManager.clear('capture');
    State.flags.captureActive = false;
    this.updateUI(message, true, false);
  },

  updateUI(message, showSteps, disableButton) {
    Utils.setContent('fingerprint-status', message);
    
    const steps = Utils.getElement('fingerprint-steps');
    if (steps) steps.style.display = showSteps ? 'block' : 'none';

    const btn = Utils.getElement('captureBtn');
    if (btn) btn.disabled = disableButton;
  },

  showRegisterButton() {
    const registerBtn = Utils.getElement('registerBtn');
    const captureBtn = Utils.getElement('captureBtn');

    if (registerBtn) registerBtn.style.display = 'inline-flex';
    if (captureBtn) captureBtn.style.display = 'none';
  },

  resetForm() {
    Utils.getElement('fingerprintId').value = '';
    Utils.getElement('userName').value = '';
    Utils.getElement('userRole').value = 'Estudiante';

    const registerBtn = Utils.getElement('registerBtn');
    const captureBtn = Utils.getElement('captureBtn');

    if (registerBtn) {
      registerBtn.style.display = 'none';
      registerBtn.disabled = false;
      registerBtn.innerHTML = 'Guardar Usuario';
    }

    if (captureBtn) {
      captureBtn.style.display = 'inline-flex';
      captureBtn.disabled = false;
    }

    this.updateUI('Esperando huella...', false, false);
    this.showNextID();
    NameValidator.reset();
  }
};

// ============================================
// REGISTRO DE USUARIO CON VALIDACIÓN
// ============================================
// ============================================
// REGISTRO CON MANEJO DE ERRORES MEJORADO
// ============================================
const Registration = {
  async register() {
    const id = Utils.getElement('fingerprintId').value.trim();
    const name = Utils.getElement('userName').value.trim();
    const role = Utils.getElement('userRole').value.trim();

    if (!id) {
      Notification.show('Debe capturar la huella primero', 'error');
      return;
    }

    if (!name || name.length < 3) {
      Notification.show('Ingrese un nombre válido (mínimo 3 caracteres)', 'error');
      return;
    }

    // Verificar nombre antes de registrar
    try {
      const { data } = await API.checkName(name);
      
      if (data.exists) {
        Notification.show('❌ Este nombre ya está registrado', 'error');
        const input = Utils.getElement('userName');
        if (input) {
          input.style.borderColor = '#dc3545';
          input.focus();
        }
        return;
      }
    } catch (error) {
      console.error('Error verificando nombre:', error);
    }

    const registerBtn = Utils.getElement('registerBtn');
    const originalText = registerBtn.innerHTML;

    registerBtn.disabled = true;
    registerBtn.innerHTML = '<span class="spinner"></span> Registrando...';

    try {
      const response = await fetch('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: parseInt(id), name, role })
      });

      const data = await response.json();

      // ⭐ MANEJAR ERRORES DE DUPLICADO (409)
      if (response.status === 409) {
        let mensaje = data.message || 'Error de duplicado';
        
        if (mensaje.includes('nombre')) {
          Notification.show('❌ Este nombre ya está registrado', 'error');
          const input = Utils.getElement('userName');
          if (input) {
            input.style.borderColor = '#dc3545';
            input.focus();
          }
        } else if (mensaje.includes('ID')) {
          Notification.show('❌ Este ID ya está registrado. Intente capturar nuevamente.', 'error');
          Fingerprint.resetForm();
        } else if (mensaje.includes('huella')) {
          Notification.show('❌ Esta huella ya está registrada', 'error');
          Fingerprint.resetForm();
        } else {
          Notification.show(`❌ ${mensaje}`, 'error');
        }
        
        registerBtn.disabled = false;
        registerBtn.innerHTML = originalText;
        return;
      }

      if (!response.ok) {
        throw new Error(data.message || `Error ${response.status}`);
      }

      Notification.show('✓ Usuario registrado correctamente', 'success');
      Fingerprint.resetForm();

      setTimeout(() => {
        Database.load();
        Users.load();
      }, 1000);

    } catch (error) {
      Notification.show(`Error: ${error.message}`, 'error');
      registerBtn.disabled = false;
      registerBtn.innerHTML = originalText;
    }
  }
};

// ============================================
// ASISTENCIA
// ============================================
const Attendance = {
  async check() {
    if (State.flags.captureActive) return;

    try {
      const response = await fetch('/api/attendance');
      const lastRecord = Utils.getElement('last-record');
      const attStatus = Utils.getElement('attendance-status');

      if (response.status === 409) {
        const data = await response.json();

        lastRecord.classList.add('warning');
        Utils.setContent('last-user', data.nombre || '---');
        Utils.setContent('last-time', 'Ya registrado hoy');
        Utils.setContent('last-type', 'Duplicado');

        if (attStatus) {
          attStatus.textContent = 'Ya registraste asistencia hoy';
        }

        Notification.show(`${data.nombre || 'Usuario'} ya registró asistencia hoy`, 'warning');

        setTimeout(() => {
          lastRecord.classList.remove('warning');
          if (attStatus) {
            attStatus.textContent = 'Esperando huella para asistencia...';
          }
        }, 5000);
        return;
      }

      if (!response.ok) return;

      const data = await response.json();

      lastRecord.classList.remove('warning');
      Utils.setContent('last-user', data.nombre || '---');
      Utils.setContent('last-time', `${data.fecha || '---'} ${data.hora || '---'}`);
      Utils.setContent('last-type', `✓ ${data.tipo || 'entrada'}`);

      if (attStatus) {
        attStatus.textContent = 'Asistencia registrada correctamente';
      }

      Notification.show(`Asistencia registrada: ${data.nombre}`, 'success');
      
      setTimeout(() => {
        Database.load();
        if (attStatus) {
          attStatus.textContent = 'Esperando huella para asistencia...';
        }
      }, 3000);

    } catch (error) {
      // Silencioso - normal cuando no hay huella
    }
  },

  startMonitoring() {
    IntervalManager.set('attendance', () => this.check(), CONFIG.ATTENDANCE_INTERVAL);
  }
};

// ============================================
// BASE DE DATOS - EXPORTACIÓN CSV CORREGIDA
// ============================================
const Database = {
  async load() {
    if (State.flags.dbLoading) return;
    State.flags.dbLoading = true;

    try {
      const { data } = await API.getDatabase();
      State.data.full = data;
      State.data.filtered = data;

      this.renderTable(data);
      this.updateStats(data);
      this.fillUserFilter(data);

    } catch (error) {
      console.error('Error cargando base de datos:', error);
      Notification.show('No se pudo cargar la base de datos', 'error');

      Utils.setHTML('attendance-table',
        "<tr><td colspan='5' style='text-align:center;padding:32px;color:#dc3545'>Error al cargar datos</td></tr>");
    } finally {
      State.flags.dbLoading = false;
    }
  },

  filter() {
    const date = Utils.getElement('filter-date').value;
    const user = Utils.getElement('filter-user').value;

    let filtered = State.data.full;

    if (date) {
      filtered = filtered.filter(r => r.fecha === date);
    }

    if (user) {
      filtered = filtered.filter(r => r.nombre === user);
    }

    State.data.filtered = filtered;
    this.renderTable(filtered);
    this.updateStats(filtered);
  },

  clearFilters() {
    Utils.getElement('filter-date').value = '';
    Utils.getElement('filter-user').value = '';
    State.data.filtered = State.data.full;
    this.renderTable(State.data.full);
    this.updateStats(State.data.full);
    Notification.show('Filtros limpiados', 'info');
  },

  renderTable(data) {
    const tbody = Utils.getElement('attendance-table');
    if (!tbody) return;

    if (!data || data.length === 0) {
      Utils.setHTML('attendance-table',
        "<tr><td colspan='5' style='text-align:center;padding:32px;color:#6c757d'>No hay registros</td></tr>");
      return;
    }

    const sortedData = [...data].reverse();
    const fragment = document.createDocumentFragment();

    sortedData.forEach(reg => {
      const row = document.createElement('tr');
      row.innerHTML = `
        <td><strong style="color:#667eea">${reg.id || '---'}</strong></td>
        <td><strong>${Utils.escapeHtml(reg.nombre || 'Desconocido')}</strong></td>
        <td>${Utils.formatDate(reg.fecha) || '---'}</td>
        <td>${Utils.formatTime(reg.hora) || '---'}</td>
        <td><span class="badge">${Utils.escapeHtml(reg.rol || 'N/A')}</span></td>
      `;
      fragment.appendChild(row);
    });

    tbody.innerHTML = '';
    tbody.appendChild(fragment);
  },

  fillUserFilter(data) {
    const users = [...new Set(data.map(r => r.nombre))].sort();
    const select = Utils.getElement('filter-user');

    if (!select) return;

    let html = '<option value="">Todos los usuarios</option>';
    users.forEach(u => {
      html += `<option value="${Utils.escapeHtml(u)}">${Utils.escapeHtml(u)}</option>`;
    });

    select.innerHTML = html;
  },

  updateStats(data) {
    Utils.setContent('stat-total', data.length);

    const today = new Date().toISOString().split('T')[0];
    const todayCount = data.filter(r => r.fecha === today).length;
    Utils.setContent('stat-today', todayCount);

    const uniqueUsers = new Set(data.map(r => r.nombre)).size;
    Utils.setContent('stat-users', uniqueUsers);
  },

  // ⭐ FUNCIÓN CORREGIDA: CSV con celdas separadas correctamente
  exportCSV() {
    if (State.data.full.length === 0) {
      Notification.show('No hay datos para exportar', 'warning');
      return;
    }

    // Crear CSV con formato correcto (sin comillas dobles innecesarias)
   let csv = 'ID;Nombre;Fecha;Hora;Cargo\n';

    State.data.full.forEach(row => {
      // Limpiar y formatear cada campo
      const id = (row.id || '').toString().trim();
      const nombre = (row.nombre || '').trim();
      const fecha = (row.fecha || '').trim();
      const hora = (row.hora || '').trim();
      const rol = (row.rol || '').trim();

      // Solo usar comillas si el campo contiene comas o comillas
      const formatField = (field) => {
        if (!field) return '';
        if (field.includes(',') || field.includes('"') || field.includes('\n')) {
          return `"${field.replace(/"/g, '""')}"`;
        }
        return field;
      };
      // Construir línea CSV
      csv += `${id};${formatField(nombre)};${fecha};${hora};${formatField(rol)}\n`;
    });

    // Crear y descargar archivo
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    this.downloadFile(blob, `asistencia_${this.getDateString()}.csv`);

    Notification.show(`✓ CSV exportado: ${State.data.full.length} registros`, 'success');
  },

  downloadFile(blob, filename) {
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
  },

  getDateString() {
    return new Date().toISOString().split('T')[0];
  },
  exportXLSX() {
  if (State.data.filtered.length === 0) {
    Notification.show('No hay datos para exportar', 'warning');
    return;
  }

  // Encabezados
  const data = [
    ['ID', 'Nombre', 'Fecha', 'Hora', 'Cargo']
  ];

  // Filas (usa datos filtrados)
  State.data.filtered.forEach(r => {
    data.push([
      r.id || '',
      r.nombre || '',
      r.fecha || '',
      r.hora || '',
      r.rol || ''
    ]);
  });

  // Crear hoja
  const ws = XLSX.utils.aoa_to_sheet(data);

  // ⭐ Ancho de columnas
  ws['!cols'] = [
    { wch: 6 },   // ID
    { wch: 35 },  // Nombre (ancha)
    { wch: 12 },  // Fecha
    { wch: 10 },  // Hora
    { wch: 15 }   // Cargo
  ];

  // Congelar encabezado
  ws['!freeze'] = { xSplit: 0, ySplit: 1 };

  // Crear libro
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Asistencia');

  // Descargar
  XLSX.writeFile(
    wb,
    `asistencia_${this.getDateString()}.xlsx`
  );

  Notification.show(
    `✓ Excel exportado (${State.data.filtered.length} registros)`,
    'success'
  );
},

};
// ============================================
// GESTIÓN DE USUARIOS
// ============================================
const Users = {
  async load() {
    if (State.flags.usersLoading) return;
    State.flags.usersLoading = true;

    const container = Utils.getElement('usersList');
    if (!container) return;

    try {
      const { data } = await API.getUsers();
      State.data.users = data;

      if (data.length === 0) {
        Utils.setHTML('usersList', `
          <div style="text-align:center;padding:60px 20px;color:#6c757d">
            <div style="font-size:4em;margin-bottom:16px">👥</div>
            <div style="font-size:1.3em;font-weight:700;margin-bottom:8px">No hay usuarios registrados</div>
            <div style="font-size:1em">Registra tu primer usuario en la pestaña "Nuevo Usuario"</div>
          </div>
        `);
        return;
      }

      this.render(data);

    } catch (error) {
      console.error('Error:', error);
      Utils.setHTML('usersList', `
        <div style="text-align:center;padding:40px;color:#dc3545">
          <div style="font-size:3em;margin-bottom:16px">✗</div>
          <div style="font-size:1.1em;font-weight:600">Error al cargar usuarios</div>
        </div>
      `);
    } finally {
      State.flags.usersLoading = false;
    }
  },

  render(users) {
    users.sort((a, b) => a.id - b.id);

    let html = `
      <div style="background:linear-gradient(135deg,#e7f3ff,#d6e9ff);padding:20px;border-radius:16px;margin-bottom:24px;text-align:center;border-left:5px solid #667eea">
        <strong style="font-size:1.2em;color:#667eea">Total: ${users.length} usuarios registrados</strong>
      </div>
      <div class="user-list">
    `;

    users.forEach(user => {
      html += `
        <div class="user-item">
          <div class="user-info">
            <div class="user-name">
              <span style="background:linear-gradient(135deg,#667eea,#764ba2);color:white;padding:4px 12px;border-radius:8px;font-size:.85em;margin-right:10px;font-weight:700">ID ${user.id}</span>
              ${Utils.escapeHtml(user.nombre)}
            </div>
            <div class="user-meta">${Utils.escapeHtml(user.rol)}</div>
          </div>
          <div class="user-actions">
            <button class="btn btn-outline" style="padding:10px 18px;font-size:.85em" onclick="Users.edit(${user.id})">
              Editar
            </button>
            <button class="btn btn-danger" style="padding:10px 18px;font-size:.85em" onclick="Users.delete(${user.id}, '${Utils.escapeHtml(user.nombre).replace(/'/g, "\\'")}')">
              Eliminar
            </button>
          </div>
        </div>
      `;
    });

    html += "</div>";
    Utils.setHTML('usersList', html);
  },

  edit(id) {
    const user = State.data.users.find(u => u.id === id);
    if (!user) return;

    Utils.getElement('edit-user-id').value = user.id;
    Utils.getElement('edit-user-name').value = user.nombre;
    Utils.getElement('edit-user-role').value = user.rol;

    Utils.getElement('editModal').classList.add('active');
  },

  closeEditModal() {
    Utils.getElement('editModal').classList.remove('active');
    
    // Limpiar feedback
    const input = Utils.getElement('edit-user-name');
    if (input) input.style.borderColor = '';
  },

  async saveEdit() {
    const id = Utils.getElement('edit-user-id').value;
    const nombre = Utils.getElement('edit-user-name').value.trim();
    const rol = Utils.getElement('edit-user-role').value;

    if (!nombre || nombre.length < 3) {
      Notification.show('El nombre debe tener al menos 3 caracteres', 'error');
      return;
    }

    // ⭐ VERIFICAR SI EL NOMBRE YA EXISTE (excepto si es el mismo usuario)
    const originalUser = State.data.users.find(u => u.id === parseInt(id));
    
    if (originalUser && originalUser.nombre.toLowerCase().trim() !== nombre.toLowerCase().trim()) {
      try {
        const { data } = await API.checkName(nombre);
        
        if (data.exists) {
          Notification.show('❌ Este nombre ya está registrado por otro usuario', 'error');
          const input = Utils.getElement('edit-user-name');
          if (input) {
            input.style.borderColor = '#dc3545';
            input.focus();
          }
          return;
        }
      } catch (error) {
        console.error('Error verificando nombre:', error);
      }
    }

    try {
      await API.editUser({ id: parseInt(id), nombre, rol });

      Notification.show('✓ Usuario actualizado', 'success');
      this.closeEditModal();
      
      setTimeout(() => {
        this.load();
        Database.load();
      }, 800);

    } catch (error) {
      if (error.message.includes('ya está registrado')) {
        Notification.show('❌ Este nombre ya está registrado por otro usuario', 'error');
      } else {
        Notification.show(`Error: ${error.message}`, 'error');
      }
    }
  },

  async delete(id, nombre) {
    if (!confirm(`¿Eliminar a "${nombre}"?\n\nSe eliminará:\n✓ Huella del sensor\n✓ Usuario del sistema\n\nLos registros históricos se mantendrán.`)) {
      return;
    }

    try {
      await API.deleteUser(id);

      Notification.show('Usuario eliminado', 'success');
      
      setTimeout(() => {
        this.load();
        Database.load();
      }, 800);

    } catch (error) {
      Notification.show(`Error: ${error.message}`, 'error');
    }
  },

  exportExcel() {
    if (State.data.users.length === 0) {
      Notification.show('No hay usuarios para exportar', 'warning');
      return;
    }

    let html = `
      <html xmlns:x="urn:schemas-microsoft-com:office:excel">
      <head>
        <meta charset="UTF-8">
        <xml>
          <x:ExcelWorkbook>
            <x:ExcelWorksheets>
              <x:ExcelWorksheet>
                <x:Name>Usuarios</x:Name>
                <x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions>
              </x:ExcelWorksheet>
            </x:ExcelWorksheets>
          </x:ExcelWorkbook>
        </xml>
        <style>
          table{border-collapse:collapse;width:100%}
          th{background-color:#667eea;color:white;font-weight:bold;padding:10px;border:1px solid #ddd}
          td{padding:8px;border:1px solid #ddd}
          tr:nth-child(even){background-color:#f2f2f2}
        </style>
      </head>
      <body>
        <table>
          <thead>
            <tr><th>ID</th><th>Nombre Completo</th><th>Cargo</th><th>Estado</th></tr>
          </thead>
          <tbody>
    `;

    State.data.users.forEach(user => {
      html += `<tr>
        <td>${user.id}</td>
        <td>${Utils.escapeHtml(user.nombre)}</td>
        <td>${Utils.escapeHtml(user.rol)}</td>
        <td>Activo</td>
      </tr>`;
    });

    html += '</tbody></table></body></html>';

    const blob = new Blob([html], { type: 'application/vnd.ms-excel' });
    Database.downloadFile(blob, `usuarios_${Database.getDateString()}.xls`);

    Notification.show(`Excel exportado: ${State.data.users.length} usuarios`, 'success');
  },

  exportJSON() {
    if (State.data.users.length === 0) {
      Notification.show('No hay usuarios para exportar', 'warning');
      return;
    }

    const jsonData = JSON.stringify(State.data.users, null, 2);
    const blob = new Blob([jsonData], { type: 'application/json' });
    Database.downloadFile(blob, `usuarios_${Database.getDateString()}.json`);

    Notification.show(`JSON exportado: ${State.data.users.length} usuarios`, 'success');
  }
};

// ============================================
// EVENT LISTENERS
// ============================================
function setupEventListeners() {
  // Navegación
  Navigation.init();

  // Captura de huella
  const captureBtn = Utils.getElement('captureBtn');
  if (captureBtn) {
    captureBtn.addEventListener('click', () => Fingerprint.start());
  }

  // Registro de usuario
  const registerBtn = Utils.getElement('registerBtn');
  if (registerBtn) {
    registerBtn.addEventListener('click', () => Registration.register());
  }

  // ⭐ VALIDACIÓN EN TIEMPO REAL DEL NOMBRE
  const userName = Utils.getElement('userName');
  if (userName) {
    userName.addEventListener('input', (e) => {
      NameValidator.debounced(e.target.value);
    });
    
    userName.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        const regBtn = Utils.getElement('registerBtn');
        if (regBtn && regBtn.style.display !== 'none' && !regBtn.disabled) {
          Registration.register();
        }
      }
    });
  }

  // ⭐ VALIDACIÓN EN MODAL DE EDICIÓN
  const editUserName = Utils.getElement('edit-user-name');
  if (editUserName) {
    editUserName.addEventListener('input', (e) => {
      // Limpiar borde rojo al escribir
      e.target.style.borderColor = '';
    });
  }

  // Filtros de reportes
  const filterDate = Utils.getElement('filter-date');
  const filterUser = Utils.getElement('filter-user');
  if (filterDate) filterDate.addEventListener('change', () => Database.filter());
  if (filterUser) filterUser.addEventListener('change', () => Database.filter());

  // Limpiar filtros
  const clearBtn = Utils.getElement('clearFiltersBtn');
  if (clearBtn) clearBtn.addEventListener('click', () => Database.clearFilters());

  // Exportar CSV
  const exportCsvBtn = Utils.getElement('exportCsvBtn');
  if (exportCsvBtn) exportCsvBtn.addEventListener('click', () => Database.exportCSV());

  // Exportar usuarios
  const exportExcelBtn = Utils.getElement('exportExcelBtn');
  const exportJsonBtn = Utils.getElement('exportJsonBtn');
  if (exportExcelBtn) exportExcelBtn.addEventListener('click', () => Users.exportExcel());
  if (exportJsonBtn) exportJsonBtn.addEventListener('click', () => Users.exportJSON());

  // Modal de edición
  const closeModalBtn = Utils.getElement('closeModalBtn');
  const cancelEditBtn = Utils.getElement('cancelEditBtn');
  const saveEditBtn = Utils.getElement('saveEditBtn');
  
  if (closeModalBtn) closeModalBtn.addEventListener('click', () => Users.closeEditModal());
  if (cancelEditBtn) cancelEditBtn.addEventListener('click', () => Users.closeEditModal());
  if (saveEditBtn) saveEditBtn.addEventListener('click', () => Users.saveEdit());
}

// ============================================
// INICIALIZACIÓN
// ============================================
function init() {
  console.log('🚀 Sistema de asistencia inicializado');

  // Configurar eventos
  setupEventListeners();

  // Cargar datos iniciales
  Database.load();
  Fingerprint.showNextID();

  // Iniciar monitoreo
  SystemStatus.startMonitoring();
  Attendance.startMonitoring();

  // Limpiar intervalos al cerrar
  window.addEventListener('beforeunload', () => {
    IntervalManager.clearAll();
  });

  console.log('✅ Sistema listo');
}

// Iniciar cuando el DOM esté listo
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}