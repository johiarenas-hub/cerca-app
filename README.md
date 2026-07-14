# Cerca — prototipo de conexión por proximidad

Prototipo funcional (web) de una app para conectar con alguien cuando ambos
estáis físicamente cerca: se comparte solo una **distancia aproximada**
(nunca la ubicación exacta), y solo se habilita el chat cuando hay un
**"me interesa" mutuo** (como un match).

Está pensado como punto de partida para una app de citas/conexión por
proximidad, no como producto terminado.

## Cómo funciona

1. Cada persona abre la app en su móvil (navegador), crea un perfil corto
   (nombre, emoji, bio, qué busca) y activa su ubicación.
2. El servidor calcula la distancia entre todas las personas que tienen la
   visibilidad activada, usando la fórmula de Haversine.
3. Si estás dentro del radio de búsqueda de otra persona (y ella del tuyo),
   aparecéis mutuamente en la lista "Cerca de ti" y en el radar, mostrando
   solo una distancia aproximada (redondeada).
4. Si ambos os dais "Me interesa", se genera un match (con una celebración
   a pantalla completa) y se abre un chat en tiempo real entre los dos.
5. Cualquiera puede bloquear a otra persona en cualquier momento.
6. Cada perfil elige hasta 6 intereses (☕ Café, 🥾 Senderismo, 🎵 Música...).
   Cuando alguien cerca comparte al menos uno contigo, te llega una
   notificación específica por eso (no solo por estar cerca), y se muestra
   como etiqueta en su tarjeta.
7. Incluye un juego de fiesta "Verdad o Reto" (18+) — ver sección dedicada
   más abajo.

## Juego "Verdad o Reto" (18+)

Pestaña "🎉 Juego" dentro de la app. **Es independiente del radar de
proximidad/citas**: no usa ubicación ni matches, y solo se juega dentro de
una sala con código de 4 caracteres, pensada para un grupo que ya está
reunido físicamente (por ejemplo, en una fiesta) y decide voluntariamente
jugar junto.

- Antes de entrar, se muestra un aviso de que es solo para mayores de 18
  años y hay que confirmar con una casilla que todos los presentes
  participan voluntariamente.
- Alguien crea una sala (elige nivel de contenido: 😄 Suave o 🌶️ Picante) y
  comparte el código de 4 caracteres con el grupo; el resto se une
  introduciendo ese código.
- El anfitrión gira una ruleta que selecciona aleatoriamente a una persona
  del grupo (selección hecha en el servidor, igual para todos en tiempo
  real). Esa persona elige Verdad o Reto y el grupo entero ve la
  pregunta/reto que le tocó.
- Se puede "pasar" a otra pregunta/reto en cualquier momento, y salir de la
  sala cuando se quiera — nadie está obligado a nada.
- El contenido "picante" es coqueto para adultos (besos en la mejilla,
  piropos, abrazos, quitarse un accesorio, preguntas sobre citas y
  atracción) pero **deliberadamente no incluye actos sexuales explícitos ni
  desnudos** — los bancos de preguntas/retos están en
  `lib/party-game.js` y se pueden editar libremente si quieres ajustar el
  tono.

## Cómo probarlo

Requiere Node.js 16 o superior. **No hace falta `npm install`**: el
prototipo no usa ninguna dependencia externa (ni `express` ni `ws`), todo
está construido con los módulos nativos de Node (incluye una implementación
propia y mínima del protocolo WebSocket en `lib/mini-ws.js`).

```bash
node server.js
```

Abre `http://localhost:3000` en el navegador.

### Probarlo con dos "personas" sin salir de tu ordenador

Como para probar la proximidad real hacen falta dos móviles cerca físicamente,
la app incluye un **modo simulación**: en la pantalla principal, despliega
"🧪 Modo simulación" e introduce manualmente una latitud/longitud. Abre la
app en dos pestañas (o dos navegadores) con coordenadas parecidas
(diferencia de pocos metros/cientos de metros) para simular dos personas
cerca una de otra, y prueba el flujo completo: verse en el radar, darse
"me interesa" mutuamente, y chatear.

Ejemplo de coordenadas cercanas para probar (Madrid, ~50 m de diferencia):
- Persona A: `40.416775, -3.703790`
- Persona B: `40.417200, -3.703790`

### Usarlo en un móvil real

Para usar la ubicación GPS real del navegador (`navigator.geolocation`),
los navegadores exigen **HTTPS** (excepto en `localhost`). Para probarlo en
tu móvil necesitas desplegar el servidor en un hosting con HTTPS (Render,
Railway, Fly.io, un VPS con certificado, etc.) o usar un túnel como ngrok
durante las pruebas.

## Privacidad y seguridad — decisiones de diseño

- El servidor **nunca envía la latitud/longitud de una persona a otra**,
  solo una distancia aproximada y redondeada (por ejemplo, "~50 m" o
  "~1.2 km"), para dificultar la triangulación de tu ubicación exacta.
- El "radar" visual coloca los puntos en un ángulo pseudo-aleatorio (no es
  una dirección real), precisamente para no revelar hacia dónde está la
  otra persona — solo la distancia importa.
- El chat solo se habilita si hay match mutuo; no se puede escribir a
  desconocidos sin que ambos hayan mostrado interés.
- Cualquiera puede desactivar su visibilidad en cualquier momento
  (pasar a "invisible") o bloquear a otra persona.
- Esto es un prototipo: no incluye verificación de identidad, moderación de
  contenido, ni protección contra perfiles falsos — imprescindibles antes
  de un lanzamiento real, especialmente tratándose de una app de citas.

## Limitaciones conocidas (es un prototipo, no un producto)

- **No hay base de datos**: todo vive en memoria del servidor. Si
  reinicias el servidor, se pierden perfiles, matches y mensajes.
- **No hay autenticación real**: cualquiera que abra la app crea un perfil
  nuevo sin verificación.
- **Bluetooth no se usa**: los navegadores web no permiten "emitir" señales
  Bluetooth de forma pasiva (el Web Bluetooth API solo sirve para
  emparejar dispositivos manualmente), así que la proximidad se calcula por
  GPS/geolocalización del navegador, no por Bluetooth. Una app nativa
  (iOS/Android) sí podría usar BLE para detección de proximidad más precisa
  en interiores, sin depender del GPS.
- **Notificaciones limitadas**: las notificaciones de match y de intereses
  en común usan la Web Notification API (funcionan con la pestaña abierta,
  incluso en segundo plano) — no son notificaciones push reales, así que si
  cierras del todo la pestaña/navegador, dejan de llegar.
- El radio de búsqueda máximo está limitado a 5 km y el mínimo a 20 m.

## Próximos pasos si quieres convertir esto en una app real

1. Mover el estado a una base de datos persistente (Postgres, Redis para
   presencia en tiempo real, etc.).
2. Añadir autenticación (teléfono/email verificado) — crítico en apps de
   citas para reducir perfiles falsos.
3. Desplegar con HTTPS para poder usar geolocalización real en móviles.
4. Si se quiere una app nativa, evaluar BLE (Bluetooth Low Energy) para
   detección de proximidad en interiores sin depender del GPS.
5. Añadir moderación de contenido, sistema de reportes real (ahora mismo
   el bloqueo es solo local a la sesión) y verificación de fotos.
6. Añadir notificaciones push para alertar de un match sin tener la app
   abierta.

## Estructura del proyecto

```
cerca-app/
├── server.js          # Servidor HTTP + lógica de proximidad/match/chat
├── lib/
│   ├── mini-ws.js      # Implementación mínima de WebSocket (sin dependencias)
│   └── party-game.js    # Lógica de salas + bancos de preguntas/retos del juego 18+
├── public/
│   ├── index.html       # Estructura de la app
│   ├── style.css        # Estilos (mobile-first)
│   └── app.js            # Lógica del cliente
└── package.json
```
