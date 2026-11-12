const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');
const path = require('path');
const AdmZip = require('adm-zip');
 
const app = express();
const PORT = 5000;
 
// Configuración Global y Coordenadas de San Carlos de Bariloche
const LAT_BARILOCHE = -41.1335;
const LON_BARILOCHE = -71.3103;
 
const URL_NOTIFICACION_EXTERNA = 'https://servicios-emergencia.gob.ar/api/alarmas';
const lecturasInvalidasConsecutivas = {};
 
// Política de guardado: en NORMAL se guarda una lectura por minuto por nodo;
// en PRECAUCION, ALERTA o con lecturas inválidas se guarda todo.
const INTERVALO_GUARDADO_NORMAL_MS = 60 * 1000;
const ultimoGuardado = {};   // por sensor: { ms, situacion } de la última lectura guardada
 
// Configuración de la API del SMN (Lectura directa del ZIP Oficial)
const SMN_URL = 'https://ssl.smn.gob.ar/dpd/zipopendata.php?dato=tiepre';
const ESTACION = 'bariloche';
const COL_ESTACION = 0, COL_FECHA = 1, COL_HORA = 2, COL_TEMP = 5;
const REF_MIN = -20, REF_MAX = 50;
 
let tempRefActual = null;     // null = todavía no hay referencia real
let tempRefObservada = null;  // Almacena fecha y hora del SMN
 
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
 
// --- 1. Inicialización de la Base de Datos SQLite ---
const db = new sqlite3.Database('./sistema_incendios.db', (err) => {
    if (err) {
        console.error('Error al abrir la base de datos:', err.message);
    } else {
        console.log('Conectado a la base de datos SQLite.');
        initDb();
    }
});
 
function initDb() {
    db.serialize(() => {
        // 1. Tabla de información del establecimiento (Bariloche)
        db.run(`
            CREATE TABLE IF NOT EXISTS establecimiento (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                nombre TEXT NOT NULL,
                latitud REAL NOT NULL,
                longitud REAL NOT NULL,
                ancho_m REAL NOT NULL,
                largo_m REAL NOT NULL
            )
        `);
 
        db.get(`SELECT COUNT(*) AS cant FROM establecimiento`, (err, row) => {
            if (row && row.cant === 0) {
                db.run(`INSERT INTO establecimiento (nombre, latitud, longitud, ancho_m, largo_m) 
                        VALUES ('Galpón Bariloche', ${LAT_BARILOCHE}, ${LON_BARILOCHE}, 40.0, 20.0)`);
            }
        });
 
        // 2. Tabla de configuración fija de nodos (posiciones relativas)
        db.run(`
            CREATE TABLE IF NOT EXISTS nodos_config (
                sensor_id TEXT PRIMARY KEY,
                pos_x_m REAL NOT NULL,
                pos_y_m REAL NOT NULL,
                radio_cobertura_m REAL DEFAULT 10.0,
                descripcion TEXT
            )
        `);
 
        db.get(`SELECT COUNT(*) AS cant FROM nodos_config`, (err, row) => {
            if (row && row.cant === 0) {
                const stmt = db.prepare(`INSERT INTO nodos_config (sensor_id, pos_x_m, pos_y_m, descripcion) VALUES (?, ?, ?, ?)`);
                stmt.run('N1', 10.0, 10.0, 'Zona Oeste - Entrada');
                stmt.run('N2', 20.0, 10.0, 'Zona Centro - Almacén');
                stmt.run('N3', 30.0, 10.0, 'Zona Este - Maquinarias');
                stmt.finalize();
            }
        });
 
        // 3. Tabla de mediciones históricas
        db.run(`
            CREATE TABLE IF NOT EXISTS mediciones (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                sensor_id TEXT NOT NULL,
                temperatura REAL NOT NULL,
                unidad TEXT DEFAULT 'C',
                humo INTEGER NOT NULL,
                estado TEXT NOT NULL,
                temp_ref REAL NOT NULL,
                t_ms INTEGER NOT NULL,
                version INTEGER NOT NULL,
                validacion_estado TEXT NOT NULL,
                FOREIGN KEY(sensor_id) REFERENCES nodos_config(sensor_id)
            )
        `);
 
        // 4. Tabla de registros de temperatura de referencia
        db.run(`
            CREATE TABLE IF NOT EXISTS registro_smn (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                temperatura_ref REAL NOT NULL,
                fuente TEXT DEFAULT 'SMN',
                exitoso BOOLEAN NOT NULL
            )
        `);
 
        // 5. Tabla de notificaciones de alertas enviadas
        db.run(`
            CREATE TABLE IF NOT EXISTS notificaciones (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                sensor_id TEXT NOT NULL,
                nivel_prioridad TEXT NOT NULL,
                metodo TEXT DEFAULT 'POST',
                respuesta_code INTEGER
            )
        `);
    });
}
 
// --- 2. Consulta Periódica al ZIP del SMN (Tu Lógica Exacta) ---
async function actualizarTemperaturaSMN() {
  try {
    const r = await axios.get(SMN_URL, {
      responseType: 'arraybuffer', timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const zip = new AdmZip(Buffer.from(r.data));
    const texto = zip.getEntries()[0].getData().toString('latin1');
 
    const campos = texto.split(/\r?\n/)
      .map(l => l.split(';').map(c => c.trim()))
      .find(c => c[COL_ESTACION] && c[COL_ESTACION].toLowerCase() === ESTACION);
 
    if (!campos) throw new Error('Estación no encontrada en el archivo');
 
    const valor = parseFloat(campos[COL_TEMP].replace(',', '.'));
    if (Number.isNaN(valor) || valor < REF_MIN || valor > REF_MAX)
      throw new Error(`Valor inválido o fuera de rango: ${campos[COL_TEMP]}`);
 
    tempRefActual = valor;
    tempRefObservada = `${campos[COL_FECHA]} ${campos[COL_HORA]}`;
    registrarSMN(valor, true);
    console.log(`[SMN] Bariloche: ${valor} °C (observado ${tempRefObservada})`);
  } catch (e) {
    console.error('[SMN] Falló la consulta:', e.message);
    registrarSMN(tempRefActual ?? 0, false);   // se conserva el último valor bueno
  }
}
 
function registrarSMN(temp, exitoso) {
    const stmt = db.prepare('INSERT INTO registro_smn (temperatura_ref, exitoso) VALUES (?, ?)');
    stmt.run(temp, exitoso ? 1 : 0);
    stmt.finalize();
}
 
// Ejecutar consulta inicial y refrescar cada 1 hora (3600000 ms)
actualizarTemperaturaSMN();
setInterval(actualizarTemperaturaSMN, 3600000);
 
// --- 3. Envío de Notificaciones en Estado de Alerta ---
async function enviarNotificacionAlerta(payload) {
    try {
        const res = await axios.post(URL_NOTIFICACION_EXTERNA, payload, { timeout: 5000 });
        console.log(`[ALERTA EXTERNA] Notificación enviada. Código: ${res.status}`);
        
        const stmt = db.prepare('INSERT INTO notificaciones (sensor_id, nivel_prioridad, respuesta_code) VALUES (?, ?, ?)');
        stmt.run(payload.sensor_id, 'MUY ALTA', res.status);
        stmt.finalize();
    } catch (error) {
        console.log(`[ALERTA EXTERNA] Notificación remota no enviada: ${error.message}`);
    }
}
 
// --- 4. Lógica de Procesamiento y Regla de Suspensión ---
function debeGuardar(sensorId, estado, validacion) {
    // La "situación" combina el estado y la validación: una lectura rechazada no es NORMAL
    const situacion = validacion !== 'ACEPTADO' ? validacion : estado;
    const ahora = Date.now();
    const anterior = ultimoGuardado[sensorId];
 
    let guardar;
    if (situacion !== 'NORMAL') {
        guardar = true;                     // PRECAUCION, ALERTA, RECHAZADO o SUSPENDIDO: siempre
    } else if (!anterior) {
        guardar = true;                     // primera lectura del nodo desde que arrancó el servidor
    } else if (anterior.situacion !== 'NORMAL') {
        guardar = true;                     // volvió a NORMAL: se registra la recuperación
    } else {
        guardar = ahora - anterior.ms >= INTERVALO_GUARDADO_NORMAL_MS;   // NORMAL: una por minuto
    }
 
    if (guardar) ultimoGuardado[sensorId] = { ms: ahora, situacion };
    return guardar;
}
 
function procesarLectura(data) {
    const sensorId = data.sensor_id;
    const tempSensor = parseFloat(data.temperatura);
    const humoSensor = parseInt(data.humo);
 
    // 1. Usar siempre la temperatura de referencia del SMN obtenida en el backend
    const tempRefValida = (tempRefActual !== null && !isNaN(tempRefActual)) ? tempRefActual : (data.temp_ref || 24.5);
 
    // 2. Evaluamos los umbrales contra la referencia real del SMN
    const tempSupera = tempSensor > (tempRefValida + 5.0);
    const humoSupera = humoSensor > 700;
 
    let estadoCalculado = 'NORMAL';
    if (tempSupera && humoSupera) {
        estadoCalculado = 'ALERTA';
    } else if (tempSupera || humoSupera) {
        estadoCalculado = 'PRECAUCION';
    } else {
        estadoCalculado = 'NORMAL';
    }
 
    // 3. Regla de Aceptación / Rechazo / Suspensión
    let validacion = 'ACEPTADO';
    if (isNaN(tempSensor) || isNaN(humoSensor)) {
        validacion = 'RECHAZADO';
        lecturasInvalidasConsecutivas[sensorId] = (lecturasInvalidasConsecutivas[sensorId] || 0) + 1;
    } else {
        lecturasInvalidasConsecutivas[sensorId] = 0;
    }
 
    if (lecturasInvalidasConsecutivas[sensorId] >= 3) {
        console.log(`[ATENCIÓN] Nodo ${sensorId} suspendido por 3 fallas consecutivas.`);
        validacion = 'SUSPENDIDO';
    }
 
    // 4. Persistencia en SQLite guardando la referencia REAL del SMN y el estado reevaluado
    //    (solo si corresponde según la política de guardado)
    if (debeGuardar(sensorId, estadoCalculado, validacion)) {
        const stmt = db.prepare(`
            INSERT INTO mediciones (sensor_id, temperatura, unidad, humo, estado, temp_ref, t_ms, version, validacion_estado)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        stmt.run(
            sensorId,
            tempSensor,
            data.unidad || 'C',
            humoSensor,
            estadoCalculado, // Guardamos el estado real corregido por el backend
            tempRefValida,   // Guardamos la referencia real del SMN
            data.t_ms || 0,
            data.version || 1,
            validacion
        );
        stmt.finalize();
    }
 
    // 5. Disparar alerta sólo si el estado calculado es ALERTA y la lectura es ACEPTADA
    if (estadoCalculado === 'ALERTA' && validacion === 'ACEPTADO') {
        enviarNotificacionAlerta({
            sensor_id: sensorId,
            temperatura: tempSensor,
            humo: humoSensor,
            temp_ref: tempRefValida,
            estado: estadoCalculado
        });
    }
}
 
// --- 5. Rutas API ---
// --- Endpoint para procesar la simulación y devolver la temp_ref real ---
app.post('/api/simular_arduino', (req, res) => {
    try {
        const data = req.body;
        if (!data || Object.keys(data).length === 0) {
            return res.status(400).json({ status: 'error', message: 'JSON inválido' });
        }
 
        procesarLectura(data);
 
        // Si por alguna razón tempRefActual es null al arrancar, buscar la última exitosa en SQLite
        if (tempRefActual === null) {
            db.get(`SELECT temperatura_ref FROM registro_smn WHERE exitoso = 1 ORDER BY id DESC LIMIT 1`, [], (err, row) => {
                const tempRefRescate = row ? row.temperatura_ref : null;
                return res.status(200).json({
                    status: 'ok',
                    message: 'Lectura procesada correctamente',
                    temp_ref_actual: tempRefRescate
                });
            });
        } else {
            return res.status(200).json({
                status: 'ok',
                message: 'Lectura procesada correctamente',
                temp_ref_actual: tempRefActual
            });
        }
    } catch (error) {
        return res.status(500).json({ status: 'error', message: error.message });
    }
});
 
// Endpoint ÚNICO /api/datos (Con JOIN y validacion_estado)
app.get('/api/datos', (req, res) => {
    db.get('SELECT latitud, longitud, ancho_m, largo_m FROM establecimiento LIMIT 1', [], (err, infoEstablecimiento) => {
        if (err) return res.status(500).json({ error: err.message });
 
        const queryMediciones = `
            SELECT 
                m.sensor_id,
                m.temperatura,
                m.humo,
                m.estado,
                m.temp_ref,
                m.timestamp,
                m.validacion_estado,
                n.pos_x_m,
                n.pos_y_m,
                n.radio_cobertura_m
            FROM mediciones m
            LEFT JOIN nodos_config n ON m.sensor_id = n.sensor_id
            ORDER BY m.id DESC LIMIT 50
        `;
 
        db.all(queryMediciones, [], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
 
            res.json({
                establecimiento: infoEstablecimiento,
                mediciones: rows,
                temp_ref_smn: tempRefActual,
                observado: tempRefObservada
            });
        });
    });
});
 
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});
 
// --- 6. Iniciar Servidor ---
app.listen(PORT, () => {
    console.log(`Servidor de monitoreo iniciado en http://localhost:${PORT}`);
});