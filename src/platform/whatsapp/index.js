// src/platform/whatsapp/index.js
//
// Fachada del modulo WhatsApp: reexporta la superficie publica (casos de uso) y
// el bloque __testing. Permite que require('.../platform/whatsapp') siga igual.

const mensajes = require('./mensajes');
const { getAdminAlertPhones, maskPhone, parsePhoneList } = require('./client');

module.exports = {
  enviarWhatsAppResumen: mensajes.enviarWhatsAppResumen,
  enviarWhatsAppFree: mensajes.enviarWhatsAppFree,
  enviarWhatsAppTodos: mensajes.enviarWhatsAppTodos,
  enviarWhatsAppRegistro: mensajes.enviarWhatsAppRegistro,
  enviarWhatsAppVerificacion: mensajes.enviarWhatsAppVerificacion,
  enviarWhatsAppResetPassword: mensajes.enviarWhatsAppResetPassword,
  enviarDigestPro: mensajes.enviarDigestPro,
  enviarWhatsAppDirecto: mensajes.enviarWhatsAppDirecto,
  enviarWhatsAppAdmin: mensajes.enviarWhatsAppAdmin,
};
module.exports.__testing = {
  getAdminAlertPhones,
  maskPhone,
  parsePhoneList,
};
