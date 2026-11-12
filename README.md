# Sistema de Alarma Temprana de Incendios
Trabajo Integrador Final - Ciudades Inteligentes

## Requisitos
- Node.js
- Internet para consultar la temperatura de referencia del SMN

## Instalación
Dentro de la carpeta del proyecto:

```
npm install express sqlite3 axios adm-zip
```

El archivo `dashboard.html` tiene que estar dentro de la carpeta `public`:

```
proyecto/
├── server.js
├── simulador_multinodo.js
└── public/
    └── dashboard.html
```

## Ejecución
1. Iniciar el servidor:
   ```
   node server.js
   ```
2. En otra terminal, iniciar el simulador:
   ```
   node simulador_multinodo.js
   ```
3. Abrir el dashboard en el navegador: http://localhost:5000/


