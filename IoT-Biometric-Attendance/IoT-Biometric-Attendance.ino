// Proyecto: Control de Asistencia ESP32
// Incluye: SD, RTC (DS3231), Sensor de huellas (Adafruit), AP WiFi, WebServer, Buzzer
#include <Wire.h>
#include <SPI.h>
#include <SD.h>
#include <RTClib.h>
#include <Adafruit_Fingerprint.h>
#include <WiFi.h>
#include <WebServer.h>
#include <ArduinoJson.h>

// Pines (ajusta si usas otros)
#define BUZZER_PIN 27
#define SD_CS_PIN 5
#define RX_PIN 16
#define TX_PIN 17

RTC_DS3231 rtc;
HardwareSerial mySerial(1);
Adafruit_Fingerprint finger = Adafruit_Fingerprint(&mySerial);
WebServer server(80);

// Variables globales para captura de huella
int tempID = -1;
bool fingerprintCaptured = false;
uint8_t captureStep = 0; // 0: esperando, 1: primera captura, 2: confirmación

// -------------------------------------------------------
// DECLARACIONES DE FUNCIONES
// -------------------------------------------------------
String buscarNombrePorID(int targetID);
String buscarRolPorID(int targetID);
int obtenerSiguienteID();
bool nombreYaRegistrado(String nombre);
bool huellaYaRegistrada();
void apiRegister();
void apiEditUser();

// -------------------------------------------------------
// Buzzer
// -------------------------------------------------------
void beep(int frequency, int durationMs) {
  tone(BUZZER_PIN, frequency, durationMs);
  delay(durationMs + 20);
  noTone(BUZZER_PIN);
}

// -------------------------------------------------------
// Verificar SD
// -------------------------------------------------------
bool iniciarSD() {
  SPI.begin(18, 19, 23); // SCK, MISO, MOSI

  if (!SD.begin(SD_CS_PIN)) {
    Serial.println("ERROR: SD no inicializada");
    beep(400, 700);
    return false;
  }

  Serial.println("SD inicializada correctamente");
  beep(1200, 120);
  return true;
}

// -------------------------------------------------------
// Guardar asistencia (append CSV)
// -------------------------------------------------------
void guardarAsistencia(int id) {
  DateTime now;
  bool rtcOK = false;
  
  if (rtc.begin()) {
    now = rtc.now();
    rtcOK = true;
  } else {
    Serial.println("ADVERTENCIA: Usando fecha de compilación (RTC no disponible)");
    now = DateTime(F(__DATE__), F(__TIME__));
    uint32_t seconds = millis() / 1000;
    now = DateTime(now.unixtime() + seconds);
  }

  char fechaBuf[20];
  sprintf(fechaBuf, "%04d-%02d-%02d", now.year(), now.month(), now.day());

  char horaBuf[20];
  sprintf(horaBuf, "%02d:%02d:%02d", now.hour(), now.minute(), now.second());

  String linea = String(id) + "," + fechaBuf + "," + horaBuf + "\n";

  File log = SD.open("/asistencia.csv", FILE_APPEND);
  if (log) {
    log.print(linea);
    log.close();
    Serial.println("Asistencia guardada: " + linea);
    if (!rtcOK) {
      Serial.println("  (Nota: Fecha/hora aproximada - RTC no disponible)");
    }
  } else {
    Serial.println("ERROR: No se pudo abrir asistencia.csv");
  }
}

// -------------------------------------------------------
// Obtener siguiente ID disponible
// -------------------------------------------------------
int obtenerSiguienteID() {
  File users = SD.open("/usuarios.json");
  int maxID = 0;
  
  if (!users) {
    Serial.println("usuarios.json no existe, empezando desde ID 1");
    return 1;
  }

  while (users.available()) {
    String line = users.readStringUntil('\n');
    line.trim();
    if (line.length() < 5) continue;

    StaticJsonDocument<256> doc;
    DeserializationError err = deserializeJson(doc, line);
    if (err) continue;

    int currentID = doc["id"] | 0;
    if (currentID > maxID) {
      maxID = currentID;
    }
  }
  users.close();

  Serial.printf("Máximo ID encontrado: %d, siguiente será: %d\n", maxID, maxID + 1);
  return maxID + 1;
}

// -------------------------------------------------------
// Buscar nombre por ID
// -------------------------------------------------------
String buscarNombrePorID(int targetID) {
  File users = SD.open("/usuarios.json");
  if (!users) {
    Serial.println("ERROR: No se pudo abrir usuarios.json");
    return "Desconocido";
  }

  while (users.available()) {
    String line = users.readStringUntil('\n');
    line.trim();
    if (line.length() < 5) continue;

    StaticJsonDocument<256> doc;
    DeserializationError err = deserializeJson(doc, line);
    if (err) continue;

    if ((int)doc["id"] == targetID) {
      String nombre = String((const char*)doc["nombre"]);
      users.close();
      return nombre;
    }
  }
  users.close();
  return "Desconocido";
}

// -------------------------------------------------------
// Buscar rol por ID
// -------------------------------------------------------
String buscarRolPorID(int targetID) {
  File users = SD.open("/usuarios.json");
  if (!users) return "N/A";

  while (users.available()) {
    String line = users.readStringUntil('\n');
    line.trim();
    if (line.length() < 5) continue;

    StaticJsonDocument<256> doc;
    DeserializationError err = deserializeJson(doc, line);
    if (err) continue;

    if ((int)doc["id"] == targetID) {
      String rol = String((const char*)doc["rol"]);
      users.close();
      return rol;
    }
  }
  users.close();
  return "N/A";
}

// -------------------------------------------------------
// Verificar si el nombre ya está registrado
// -------------------------------------------------------
bool nombreYaRegistrado(String nombre) {
  File users = SD.open("/usuarios.json");
  if (!users) return false;

  nombre.toLowerCase();
  nombre.trim();

  while (users.available()) {
    String line = users.readStringUntil('\n');
    line.trim();
    if (line.length() < 5) continue;

    StaticJsonDocument<256> doc;
    DeserializationError err = deserializeJson(doc, line);
    if (err) continue;

    String nombreExistente = String((const char*)doc["nombre"]);
    nombreExistente.toLowerCase();
    nombreExistente.trim();

    if (nombreExistente == nombre) {
      users.close();
      Serial.println("⚠️  Nombre duplicado encontrado: " + nombre);
      return true;
    }
  }
  users.close();
  return false;
}

// -------------------------------------------------------
// ⭐ NUEVA FUNCIÓN: Verificar si la huella ya está registrada
// -------------------------------------------------------
bool huellaYaRegistrada() {
  Serial.println("🔍 Verificando si la huella ya existe en el sensor...");
  
  // Buscar coincidencia en toda la base de datos del sensor
  int result = finger.fingerFastSearch();
  
  if (result == FINGERPRINT_OK) {
    int idEncontrado = finger.fingerID;
    int confianza = finger.confidence;
    
    Serial.println("⚠️  ¡HUELLA DUPLICADA DETECTADA!");
    Serial.printf("   - Ya está registrada con ID: %d\n", idEncontrado);
    Serial.printf("   - Confianza de coincidencia: %d\n", confianza);
    Serial.printf("   - Pertenece a: %s\n", buscarNombrePorID(idEncontrado).c_str());
    
    return true;
  }
  
  Serial.println("✓ Huella nueva, no existe duplicado");
  return false;
}

// -------------------------------------------------------
// API: /api/fingerprint/start - CON VALIDACIÓN DE DUPLICADOS
// -------------------------------------------------------
void apiStartFingerprint() {
  Serial.println("API: /api/fingerprint/start -> captura paso " + String(captureStep));

  // PASO 0: Esperando primera huella
  if (captureStep == 0) {
    int res = finger.getImage();
    if (res != FINGERPRINT_OK) {
      server.send(200, "application/json", "{\"step\":0,\"msg\":\"Coloque el dedo\"}");
      return;
    }

    // Convertir primera imagen
    res = finger.image2Tz(1);
    if (res != FINGERPRINT_OK) {
      Serial.println("Error en image2Tz(1)");
      server.send(200, "application/json", "{\"step\":0,\"msg\":\"Error al procesar imagen\"}");
      return;
    }

    // ⭐ VALIDACIÓN 1: Verificar si la huella ya existe
    if (huellaYaRegistrada()) {
      int idExistente = finger.fingerID;
      String nombreExistente = buscarNombrePorID(idExistente);
      
      Serial.println("❌ CAPTURA RECHAZADA: Huella duplicada");
      
      captureStep = 0; // Reiniciar proceso
      beep(400, 200);
      delay(100);
      beep(400, 200);
      
      String payload = "{\"step\":-1,\"error\":\"duplicate\",\"id\":" + 
                       String(idExistente) + 
                       ",\"nombre\":\"" + nombreExistente + 
                       "\",\"msg\":\"Esta huella ya pertenece a " + nombreExistente + "\"}";
      
      server.send(409, "application/json", payload);
      return;
    }

    Serial.println("✓ Primera captura exitosa (huella única)");
    captureStep = 1;
    beep(1000, 100);
    server.send(200, "application/json", "{\"step\":1,\"msg\":\"Retire el dedo\"}");
    return;
  }

  // PASO 1: Esperando segunda huella (confirmación)
  if (captureStep == 1) {
    int res = finger.getImage();
    if (res != FINGERPRINT_OK) {
      server.send(200, "application/json", "{\"step\":1,\"msg\":\"Coloque el dedo nuevamente\"}");
      return;
    }

    // Convertir segunda imagen
    res = finger.image2Tz(2);
    if (res != FINGERPRINT_OK) {
      Serial.println("Error en image2Tz(2)");
      captureStep = 0;
      server.send(200, "application/json", "{\"step\":0,\"msg\":\"Error. Intente nuevamente\"}");
      return;
    }

    // Crear modelo
    res = finger.createModel();
    if (res != FINGERPRINT_OK) {
      Serial.println("Error en createModel()");
      captureStep = 0;
      server.send(200, "application/json", "{\"step\":0,\"msg\":\"Las huellas no coinciden\"}");
      return;
    }

    // ⭐ VALIDACIÓN 2: Verificar nuevamente después de crear el modelo
    if (huellaYaRegistrada()) {
      int idExistente = finger.fingerID;
      String nombreExistente = buscarNombrePorID(idExistente);
      
      Serial.println("❌ CAPTURA RECHAZADA: Huella duplicada (confirmación)");
      
      captureStep = 0;
      beep(400, 200);
      delay(100);
      beep(400, 200);
      
      String payload = "{\"step\":-1,\"error\":\"duplicate\",\"id\":" + 
                       String(idExistente) + 
                       ",\"nombre\":\"" + nombreExistente + 
                       "\",\"msg\":\"Esta huella ya pertenece a " + nombreExistente + "\"}";
      
      server.send(409, "application/json", payload);
      return;
    }

    // Generar ID secuencial
    tempID = obtenerSiguienteID();
    fingerprintCaptured = true;
    
    Serial.println("✓✓ Huella capturada exitosamente. ID asignado: " + String(tempID));
    
    String payload = "{\"step\":2,\"id\":" + String(tempID) + ",\"msg\":\"Huella capturada\"}";
    server.send(200, "application/json", payload);
    
    beep(1500, 200);
    captureStep = 2;
    return;
  }

  // PASO 2: Ya está capturada
  if (captureStep == 2) {
    String payload = "{\"step\":2,\"id\":" + String(tempID) + ",\"msg\":\"Huella ya capturada\"}";
    server.send(200, "application/json", payload);
    return;
  }
}

// -------------------------------------------------------
// API: /api/register - CON VALIDACIÓN COMPLETA
// -------------------------------------------------------
void apiRegister() {
  Serial.println("\n========== REGISTRO DE USUARIO ==========");

  if (server.method() != HTTP_POST) {
    server.send(405, "application/json", "{\"message\":\"Use POST\"}");
    return;
  }

  String body = server.arg("plain");
  Serial.println("Body recibido: " + body);

  if (body.length() == 0) {
    server.send(400, "application/json", "{\"message\":\"Body vacio\"}");
    return;
  }

  StaticJsonDocument<512> doc;
  DeserializationError err = deserializeJson(doc, body);
  if (err) {
    Serial.print("ERROR JSON: ");
    Serial.println(err.c_str());
    server.send(400, "application/json", "{\"message\":\"JSON invalido\"}");
    return;
  }

  int id = doc["id"] | -1;
  const char* nombre = doc["name"] | "";
  const char* role = doc["role"] | "";

  Serial.printf("ID: %d, Nombre: %s, Rol: %s\n", id, nombre, role);

  // Validación de ID
  if (id < 0 || id > 255) {
    server.send(400, "application/json", "{\"message\":\"ID invalido (0-255)\"}");
    return;
  }

  // Validación de nombre
  if (strlen(nombre) < 3) {
    server.send(400, "application/json", "{\"message\":\"Nombre muy corto\"}");
    return;
  }

  // ⭐ VALIDACIÓN: Nombre único
  if (nombreYaRegistrado(String(nombre))) {
    Serial.println("❌ Nombre duplicado: " + String(nombre));
    server.send(409, "application/json", "{\"message\":\"Este nombre ya está registrado\"}");
    beep(400, 200);
    delay(100);
    beep(400, 200);
    return;
  }

  // Validación de huella capturada
  if (!fingerprintCaptured || tempID != id) {
    server.send(400, "application/json", "{\"message\":\"Huella no capturada o ID no coincide\"}");
    return;
  }

  // ⭐ VALIDACIÓN: ID único en usuarios.json
  File usersCheck = SD.open("/usuarios.json");
  if (usersCheck) {
    while (usersCheck.available()) {
      String line = usersCheck.readStringUntil('\n');
      line.trim();
      if (line.length() < 5) continue;

      StaticJsonDocument<256> checkDoc;
      if (deserializeJson(checkDoc, line) == DeserializationError::Ok) {
        int existingId = checkDoc["id"];
        if (existingId == id) {
          usersCheck.close();
          Serial.printf("❌ ID %d ya existe en usuarios.json\n", id);
          server.send(409, "application/json", "{\"message\":\"Este ID ya está registrado\"}");
          beep(400, 200);
          delay(100);
          beep(400, 200);
          return;
        }
      }
    }
    usersCheck.close();
  }

  // Guardar modelo en sensor
  Serial.printf("Guardando modelo en slot %d...\n", id);
  uint8_t result = finger.storeModel(id);
  
  if (result != FINGERPRINT_OK) {
    Serial.printf("ERROR al guardar modelo: %d\n", result);
    server.send(500, "application/json", "{\"message\":\"Error al guardar huella en sensor\"}");
    beep(400, 500);
    return;
  }

  Serial.println("✓ Modelo guardado en sensor");

  // Guardar en SD
  File users = SD.open("/usuarios.json", FILE_APPEND);
  if (!users) {
    Serial.println("ERROR: No se pudo abrir usuarios.json");
    server.send(500, "application/json", "{\"message\":\"Error al abrir archivo SD\"}");
    return;
  }

  String nombreEscaped = String(nombre);
  nombreEscaped.replace("\"", "\\\"");
  
  String uline = "{\"id\":" + String(id) + 
                 ",\"nombre\":\"" + nombreEscaped + 
                 "\",\"rol\":\"" + String(role) + "\"}\n";

  users.print(uline);
  users.close();

  Serial.println("✓ Usuario guardado en SD: " + uline);
  Serial.println("========== REGISTRO EXITOSO ==========\n");

  // Resetear estado
  fingerprintCaptured = false;
  captureStep = 0;
  tempID = -1;

  server.send(200, "application/json", "{\"message\":\"Usuario registrado correctamente\"}");
  beep(1500, 150);
  delay(100);
  beep(1800, 150);
}

// -------------------------------------------------------
// API: /api/edit-user
// -------------------------------------------------------
void apiEditUser() {
  if (server.method() != HTTP_POST) {
    server.send(405, "application/json", "{\"message\":\"Use POST\"}");
    return;
  }

  String body = server.arg("plain");
  StaticJsonDocument<256> doc;
  DeserializationError err = deserializeJson(doc, body);
  
  if (err) {
    server.send(400, "application/json", "{\"message\":\"JSON invalido\"}");
    return;
  }

  int id = doc["id"] | -1;
  const char* nuevoNombre = doc["nombre"] | "";
  const char* nuevoRol = doc["rol"] | "";
  
  if (id < 0 || strlen(nuevoNombre) < 3) {
    server.send(400, "application/json", "{\"message\":\"Datos invalidos\"}");
    return;
  }

  Serial.printf("\n========== EDITANDO USUARIO ID: %d ==========\n", id);

  // Validar nombre único (excepto el mismo usuario)
  File usersCheck = SD.open("/usuarios.json");
  String nombreOriginal = "";
  
  if (usersCheck) {
    String nuevoNombreLower = String(nuevoNombre);
    nuevoNombreLower.toLowerCase();
    nuevoNombreLower.trim();
    
    while (usersCheck.available()) {
      String line = usersCheck.readStringUntil('\n');
      line.trim();
      if (line.length() < 5) continue;
      
      StaticJsonDocument<256> lineDoc;
      if (deserializeJson(lineDoc, line) == DeserializationError::Ok) {
        int currentId = lineDoc["id"];
        String currentName = String((const char*)lineDoc["nombre"]);
        
        if (currentId == id) {
          nombreOriginal = currentName;
        } else {
          String currentNameLower = currentName;
          currentNameLower.toLowerCase();
          currentNameLower.trim();
          
          if (currentNameLower == nuevoNombreLower) {
            usersCheck.close();
            Serial.println("❌ Nombre duplicado: " + String(nuevoNombre));
            server.send(409, "application/json", "{\"message\":\"Este nombre ya está registrado por otro usuario\"}");
            beep(400, 200);
            delay(100);
            beep(400, 200);
            return;
          }
        }
      }
    }
    usersCheck.close();
  }

  // Reescribir archivo
  File usersRead = SD.open("/usuarios.json");
  File usersTemp = SD.open("/usuarios_temp.json", FILE_WRITE);
  
  bool userFound = false;
  
  if (usersRead && usersTemp) {
    while (usersRead.available()) {
      String line = usersRead.readStringUntil('\n');
      line.trim();
      
      if (line.length() < 5) continue;
      
      StaticJsonDocument<256> lineDoc;
      if (deserializeJson(lineDoc, line) == DeserializationError::Ok) {
        if ((int)lineDoc["id"] == id) {
          userFound = true;
          String uline = "{\"id\":" + String(id) + 
                        ",\"nombre\":\"" + String(nuevoNombre) + 
                        "\",\"rol\":\"" + String(nuevoRol) + "\"}\n";
          usersTemp.print(uline);
          Serial.println("✓ Usuario actualizado: " + String(nuevoNombre));
          continue;
        }
      }
      
      usersTemp.println(line);
    }
    
    usersRead.close();
    usersTemp.close();
    
    SD.remove("/usuarios.json");
    SD.rename("/usuarios_temp.json", "/usuarios.json");
    
    Serial.println("✓ usuarios.json actualizado");
  }

  if (!userFound) {
    server.send(404, "application/json", "{\"message\":\"Usuario no encontrado\"}");
    return;
  }

  server.send(200, "application/json", "{\"message\":\"Usuario actualizado correctamente\"}");
  beep(1200, 100);
  Serial.println("========== EDICIÓN EXITOSA ==========\n");
}

// -------------------------------------------------------
// Verificar si ya registró hoy
// -------------------------------------------------------
bool yaRegistroHoy(int id) {
  DateTime now;
  if (rtc.begin()) {
    now = rtc.now();
  } else {
    now = DateTime(F(__DATE__), F(__TIME__));
    now = DateTime(now.unixtime() + (millis() / 1000));
  }
  
  char fechaHoy[20];
  sprintf(fechaHoy, "%04d-%02d-%02d", now.year(), now.month(), now.day());
  
  File f = SD.open("/asistencia.csv");
  if (!f) return false;
  
  while (f.available()) {
    String line = f.readStringUntil('\n');
    line.trim();
    if (line.length() < 3) continue;
    
    int c1 = line.indexOf(',');
    int c2 = line.indexOf(',', c1 + 1);
    
    if (c1 < 0 || c2 < 0) continue;
    
    String idStr = line.substring(0, c1);
    String fecha = line.substring(c1 + 1, c2);
    
    if (idStr.toInt() == id && fecha == String(fechaHoy)) {
      f.close();
      Serial.printf("Usuario ID %d ya registró hoy (%s)\n", id, fechaHoy);
      return true;
    }
  }
  
  f.close();
  return false;
}

// -------------------------------------------------------
// API: /api/attendance
// -------------------------------------------------------
void apiAttendance() {
  int res = finger.getImage();
  if (res != FINGERPRINT_OK) {
    server.send(400, "application/json", "{\"error\":\"No hay dedo\"}");
    return;
  }

  res = finger.image2Tz();
  if (res != FINGERPRINT_OK) {
    server.send(400, "application/json", "{\"error\":\"Error al convertir imagen\"}");
    return;
  }

  res = finger.fingerFastSearch();
  if (res != FINGERPRINT_OK) {
    Serial.println("Huella no encontrada");
    server.send(404, "application/json", "{\"error\":\"Huella no registrada\"}");
    beep(300, 300);
    return;
  }

  int id = finger.fingerID;
  int confidence = finger.confidence;

  Serial.printf("Huella encontrada: ID=%d, Confianza=%d\n", id, confidence);

  String nombreReal = buscarNombrePorID(id);
  guardarAsistencia(id);

  DateTime now = rtc.now();

  StaticJsonDocument<512> resp;
  resp["id"] = id;
  resp["nombre"] = nombreReal;
  resp["confidence"] = confidence;
  
  char fechaBuf[20];
  sprintf(fechaBuf, "%04d-%02d-%02d", now.year(), now.month(), now.day());
  resp["fecha"] = fechaBuf;
  
  char horaBuf[20];
  sprintf(horaBuf, "%02d:%02d:%02d", now.hour(), now.minute(), now.second());
  resp["hora"] = horaBuf;
  
  resp["tipo"] = "entrada";

  String out;
  serializeJson(resp, out);
  server.send(200, "application/json", out);

  beep(1500, 120);
}

// -------------------------------------------------------
// API: /api/database
// -------------------------------------------------------
void apiDatabase() {
  Serial.println("API: /api/database");

  File f = SD.open("/asistencia.csv");
  if (!f) {
    File newFile = SD.open("/asistencia.csv", FILE_WRITE);
    if (newFile) newFile.close();
    server.send(200, "application/json", "[]");
    return;
  }

  DynamicJsonDocument doc(8192);
  JsonArray arr = doc.to<JsonArray>();

  int count = 0;
  while (f.available() && count < 100) {
    String line = f.readStringUntil('\n');
    line.trim();
    if (line.length() < 3) continue;

    int c1 = line.indexOf(',');
    int c2 = line.indexOf(',', c1 + 1);

    if (c1 < 0 || c2 < 0) continue;

    String idStr = line.substring(0, c1);
    String fecha = line.substring(c1 + 1, c2);
    String hora = line.substring(c2 + 1);

    int id = idStr.toInt();

    JsonObject o = arr.createNestedObject();
    o["id"] = idStr;
    o["nombre"] = buscarNombrePorID(id);
    o["fecha"] = fecha;
    o["hora"] = hora;
    o["rol"] = buscarRolPorID(id);
    
    count++;
  }

  f.close();

  String out;
  serializeJson(arr, out);
  server.send(200, "application/json", out);
}

// -------------------------------------------------------
// Setup
// -------------------------------------------------------
void setup() {
  Serial.begin(115200);
  delay(500);
  pinMode(BUZZER_PIN, OUTPUT);

  Serial.println("\n========================================");
  Serial.println("Sistema de Asistencia ESP32");
  Serial.println("========================================\n");

  bool sdOK = iniciarSD();
  if (!sdOK) {
    Serial.println("ADVERTENCIA: Sistema continuará sin SD");
  }

  if (sdOK) {
    File test = SD.open("/index.html");
    if (!test) {
      Serial.println("ERROR: index.html NO ENCONTRADO");
    } else {
      Serial.println("✓ index.html encontrado");
      test.close();
    }
  }

  Wire.begin();
  
  Serial.println("\n🔍 Escaneando bus I2C...");
  byte deviceCount = 0;
  for (byte address = 1; address < 127; address++) {
    Wire.beginTransmission(address);
    byte error = Wire.endTransmission();
    
    if (error == 0) {
      Serial.print("  ✓ Dispositivo en 0x");
      if (address < 16) Serial.print("0");
      Serial.println(address, HEX);
      deviceCount++;
      
      if (address == 0x68) {
        Serial.println("    → DS3231 RTC");
      }
    }
  }
  
  if (deviceCount == 0) {
    Serial.println("  ⚠️  No se encontraron dispositivos I2C");
  }
  Serial.println("");
  
  if (!rtc.begin()) {
    Serial.println("⚠️  RTC NO DETECTADO");
  } else {
    DateTime now = rtc.now();
    Serial.printf("✓ RTC OK - %04d-%02d-%02d %02d:%02d:%02d\n",
                  now.year(), now.month(), now.day(),
                  now.hour(), now.minute(), now.second());
    
    if (now.year() < 2024) {
      Serial.println("⚠️  Ajustando RTC...");
      rtc.adjust(DateTime(F(__DATE__), F(__TIME__)));
    }
  }

  mySerial.begin(57600, SERIAL_8N1, RX_PIN, TX_PIN);
  delay(100);
  finger.begin(57600);
  
  if (finger.verifyPassword()) {
    Serial.println("✓ Sensor de huellas conectado");
    finger.getParameters();
    Serial.print("  - Capacidad: ");
    Serial.println(finger.capacity);
    Serial.print("  - Templates: ");
    Serial.println(finger.templateCount);
  } else {
    Serial.println("ERROR: Sensor no responde");
  }

  IPAddress local_IP(192, 168, 4, 1);
  IPAddress gateway(192, 168, 4, 1);
  IPAddress subnet(255, 255, 255, 0);

  WiFi.softAP("AguasFrescas", "12345678");
  delay(200);
  WiFi.softAPConfig(local_IP, gateway, subnet);
  WiFi.softAPsetHostname("AguasFrescas-ESP32");

  Serial.println("\n✓ WiFi AP Creado");
  Serial.println("  - SSID: AguasFrescas");
  Serial.println("  - IP: 192.168.4.1");

  server.on("/api/fingerprint/start", HTTP_GET, apiStartFingerprint);
  server.on("/api/register", HTTP_POST, apiRegister);
  server.on("/api/attendance", HTTP_GET, apiAttendance);
  server.on("/api/database", HTTP_GET, apiDatabase);
  
  server.on("/api/next-id", HTTP_GET, []() {
    int nextID = obtenerSiguienteID();
    String response = "{\"nextId\":" + String(nextID) + "}";
    server.send(200, "application/json", response);
  });

  server.on("/api/system-status", HTTP_GET, []() {
    StaticJsonDocument<256> doc;
    doc["esp32"] = true;
    doc["sensor"] = finger.verifyPassword();
    doc["rtc"] = rtc.begin();
    doc["sd"] = SD.begin(SD_CS_PIN);
    
    if (rtc.begin()) {
      DateTime now = rtc.now();
      char buffer[20];
      sprintf(buffer, "%04d-%02d-%02d %02d:%02d:%02d", 
              now.year(), now.month(), now.day(),
              now.hour(), now.minute(), now.second());
      doc["datetime"] = buffer;
    }
    
    String response;
    serializeJson(doc, response);
    server.send(200, "application/json", response);
  });

  server.on("/api/check-name", HTTP_POST, []() {
    if (server.method() != HTTP_POST) {
      server.send(405, "application/json", "{\"message\":\"Use POST\"}");
      return;
    }

    String body = server.arg("plain");
    StaticJsonDocument<128> doc;
    DeserializationError err = deserializeJson(doc, body);
    
    if (err) {
      server.send(400, "application/json", "{\"message\":\"JSON invalido\"}");
      return;
    }

    const char* nombre = doc["name"] | "";
    
    if (strlen(nombre) < 3) {
      server.send(200, "application/json", "{\"exists\":false}");
      return;
    }

    bool exists = nombreYaRegistrado(String(nombre));
    
    String response = exists ? 
      "{\"exists\":true,\"message\":\"Este nombre ya está registrado\"}" : 
      "{\"exists\":false}";
    
    server.send(200, "application/json", response);
  });

  server.on("/api/delete-user", HTTP_POST, []() {
    if (server.method() != HTTP_POST) {
      server.send(405, "application/json", "{\"message\":\"Use POST\"}");
      return;
    }

    String body = server.arg("plain");
    StaticJsonDocument<128> doc;
    DeserializationError err = deserializeJson(doc, body);
    
    if (err) {
      server.send(400, "application/json", "{\"message\":\"JSON invalido\"}");
      return;
    }

    int id = doc["id"] | -1;
    
    if (id < 0) {
      server.send(400, "application/json", "{\"message\":\"ID invalido\"}");
      return;
    }

    Serial.printf("\n========== ELIMINANDO USUARIO ID: %d ==========\n", id);

    if (finger.deleteModel(id) == FINGERPRINT_OK) {
      Serial.println("✓ Huella eliminada del sensor");
    } else {
      Serial.println("⚠️  No se pudo eliminar del sensor");
    }

    File usersRead = SD.open("/usuarios.json");
    File usersTemp = SD.open("/usuarios_temp.json", FILE_WRITE);
    
    bool userFound = false;
    String userName = "Desconocido";
    
    if (usersRead && usersTemp) {
      while (usersRead.available()) {
        String line = usersRead.readStringUntil('\n');
        line.trim();
        
        if (line.length() < 5) continue;
        
        StaticJsonDocument<256> lineDoc;
        if (deserializeJson(lineDoc, line) == DeserializationError::Ok) {
          if ((int)lineDoc["id"] == id) {
            userFound = true;
            userName = String((const char*)lineDoc["nombre"]);
            Serial.println("✓ Usuario encontrado: " + userName);
            continue;
          }
        }
        
        usersTemp.println(line);
      }
      
      usersRead.close();
      usersTemp.close();
      
      SD.remove("/usuarios.json");
      SD.rename("/usuarios_temp.json", "/usuarios.json");
      
      Serial.println("✓ usuarios.json actualizado");
    }

    if (!userFound) {
      server.send(404, "application/json", "{\"message\":\"Usuario no encontrado\"}");
      return;
    }

    String response = "{\"message\":\"Usuario eliminado\",\"nombre\":\"" + userName + "\"}";
    server.send(200, "application/json", response);
    beep(1000, 100);
    delay(50);
    beep(800, 100);
    Serial.println("========== ELIMINACIÓN EXITOSA ==========\n");
  });

  server.on("/api/users", HTTP_GET, []() {
    File users = SD.open("/usuarios.json");
    
    if (!users) {
      server.send(200, "application/json", "[]");
      return;
    }

    DynamicJsonDocument doc(4096);
    JsonArray arr = doc.to<JsonArray>();

    while (users.available()) {
      String line = users.readStringUntil('\n');
      line.trim();
      if (line.length() < 5) continue;

      StaticJsonDocument<256> lineDoc;
      if (deserializeJson(lineDoc, line) == DeserializationError::Ok) {
        JsonObject obj = arr.createNestedObject();
        obj["id"] = lineDoc["id"];
        obj["nombre"] = lineDoc["nombre"];
        obj["rol"] = lineDoc["rol"];
      }
    }
    users.close();

    String response;
    serializeJson(arr, response);
    server.send(200, "application/json", response);
  });

  server.on("/api/edit-user", HTTP_POST, apiEditUser);

  if (sdOK) {
    server.serveStatic("/", SD, "/index.html");
    server.serveStatic("/scripts.js", SD, "/scripts.js");
    server.serveStatic("/style.css", SD, "/style.css");
  }

  server.onNotFound([]() {
    String path = server.uri();
    Serial.println("Request: " + path);

    if (path == "/") path = "/index.html";

    if (SD.exists(path)) {
      File file = SD.open(path, FILE_READ);
      if (file) {
        String contentType = "text/plain";
        if (path.endsWith(".html")) contentType = "text/html";
        else if (path.endsWith(".css")) contentType = "text/css";
        else if (path.endsWith(".js")) contentType = "application/javascript";
        else if (path.endsWith(".json")) contentType = "application/json";

        server.streamFile(file, contentType);
        file.close();
        return;
      }
    }

    if (SD.exists("/index.html")) {
      File home = SD.open("/index.html", FILE_READ);
      if (home) {
        server.streamFile(home, "text/html");
        home.close();
        return;
      }
    }

    server.send(404, "text/plain", "404: No encontrado");
  });

  server.begin();
  Serial.println("\n✓ Servidor HTTP iniciado");
  Serial.println("========================================\n");
  Serial.println("Accede a http://192.168.4.1");
  
  beep(1000, 100);
  delay(100);
  beep(1200, 100);
  delay(100);
  beep(1500, 100);
}

void loop() {
  server.handleClient();
  delay(2);
}