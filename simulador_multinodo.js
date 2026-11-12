const axios = require('axios');

const URL_SERVER = 'http://localhost:5000/api/simular_arduino';

// Estado inicial de los nodos del galpón
const nodos = [
    { id: 'N1', temp: 18.0, humo: 700 },
    { id: 'N2', temp: 19.5, humo: 700 },
    { id: 'N3', temp: 17.8, humo: 680 }
];

let tempRefServidor = null; // Inicia dinámico, sin hardcode de 24.5

async function simularCiclo() {
   
    for (let nodo of nodos) {
        // Variación aleatoria realista del entorno
        nodo.temp += (Math.random() - 0.48) * 0.5;
        nodo.humo += Math.floor((Math.random() - 0.48) * 8);


        // Construcción del paquete de datos
        const payload = {
            sensor_id: nodo.id,
            temperatura: parseFloat(nodo.temp.toFixed(1)),
            unidad: 'C',
            humo: nodo.humo,
            temp_ref: tempRefServidor, // Se envía null en la 1era petición y luego se sincroniza con el SMN
            t_ms: Date.now(),
            version: 1,
            estado: 'NORMAL' // El backend reevaluará el estado real contra el SMN
        };

        try {
            const res = await axios.post(URL_SERVER, payload);
            
            // Sincronización dinámica: asignamos la temperatura real extraída del SMN por el backend
            if (res.data && res.data.temp_ref_actual !== null && res.data.temp_ref_actual !== undefined) {
                tempRefServidor = res.data.temp_ref_actual;
            }

            console.log(`[${nodo.id}] Enviado -> Temp: ${payload.temperatura}°C | Humo: ${payload.humo} | Ref SMN: ${tempRefServidor ?? 'Obteniendo...'}°C`);
        } catch (error) {
            console.error(`[${nodo.id}] Error al enviar al servidor:`, error.message);
        }
    }
}

console.log('🚀 Iniciando simulador multinodo (Sincronizado con SMN Bariloche)...');
setInterval(simularCiclo, 4000);
simularCiclo();