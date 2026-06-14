(function () {
  const API_BASE = getApiBase();
  const STORAGE_TOKEN_KEY = "ruralicos_user_token";
  const PASSWORD_POLICY_MESSAGE = "La contrasena debe tener 8 caracteres, una mayuscula, un numero y un simbolo.";

  const PROVINCIAS = [
    "Alava", "Albacete", "Alicante", "Almeria", "Asturias", "Avila", "Badajoz", "Barcelona",
    "Burgos", "Caceres", "Cadiz", "Cantabria", "Castellon", "Ciudad Real", "Cordoba", "Cuenca",
    "Girona", "Granada", "Guadalajara", "Gipuzkoa", "Huelva", "Huesca", "Illes Balears", "Jaen",
    "La Coruna", "La Rioja", "Las Palmas", "Leon", "Lleida", "Lugo", "Madrid", "Malaga",
    "Murcia", "Navarra", "Ourense", "Palencia", "Pontevedra", "Salamanca", "Segovia", "Sevilla",
    "Soria", "Tarragona", "Santa Cruz de Tenerife", "Teruel", "Toledo", "Valencia", "Valladolid",
    "Bizkaia", "Zamora", "Zaragoza"
  ];

  const SUBSECTORES = [
    { id: "ovino", label: "Ovino" },
    { id: "vacuno", label: "Vacuno" },
    { id: "caprino", label: "Caprino" },
    { id: "porcino", label: "Porcino" },
    { id: "avicultura", label: "Avicultura" },
    { id: "cunicultura", label: "Cunicultura" },
    { id: "equinocultura", label: "Equinocultura" },
    { id: "apicultura", label: "Apicultura" },
    { id: "trigo", label: "Trigo" },
    { id: "cebada", label: "Cebada" },
    { id: "cereal", label: "Cereal" },
    { id: "maiz", label: "Maiz" },
    { id: "arroz", label: "Arroz" },
    { id: "hortalizas", label: "Hortalizas" },
    { id: "frutales", label: "Frutales" },
    { id: "olivar", label: "Olivar" },
    { id: "trufas", label: "Trufas" },
    { id: "vinedo", label: "Vinedo" },
    { id: "almendro", label: "Almendro" },
    { id: "citricos", label: "Citricos" },
    { id: "frutos_secos", label: "Frutos secos" },
    { id: "leguminosas", label: "Leguminosas" },
    { id: "patata", label: "Patata" },
    { id: "forrajes", label: "Forrajes" },
    { id: "forestal", label: "Forestal" },
    { id: "agua", label: "Agua" },
    { id: "energia", label: "Energia" },
    { id: "medio_ambiente", label: "Medio ambiente" }
  ];

  const TIPOS_ALERTA = [
    { id: "ayudas_subvenciones", label: "Ayudas y subvenciones" },
    { id: "normativa_general", label: "Normativa general" },
    { id: "agua_infraestructuras", label: "Agua e infraestructuras" },
    { id: "fiscalidad", label: "Fiscalidad" },
    { id: "medio_ambiente", label: "Medio ambiente" }
  ];

  const page = document.body.dataset.page;

  if (page === "register") initRegisterPage();
  if (page === "login") initLoginPage();
  if (page === "recover") initRecoverPage();
  if (page === "account") initAccountPage();

  function getApiBase() {
    const host = window.location.hostname;
    if (host === "localhost" || host === "127.0.0.1" || host.includes("ruralicos-api")) {
      return window.location.origin;
    }
    return "https://ruralicos-api.onrender.com";
  }

  function byId(id) {
    return document.getElementById(id);
  }

  function normalizePhone(prefix, phone) {
    const prefixDigits = String(prefix || "34").replace(/\D/g, "");
    let numberDigits = String(phone || "").replace(/\D/g, "");

    if (numberDigits.startsWith(prefixDigits)) {
      return numberDigits;
    }

    if (numberDigits.length === 9) {
      return prefixDigits + numberDigits;
    }

    return numberDigits;
  }

  function setNotice(element, message, type) {
    if (!element) return;
    if (!message) {
      element.className = "notice";
      element.textContent = "";
      return;
    }
    element.textContent = message;
    element.className = "notice is-visible notice-" + type;
  }

  function passwordCumplePolitica(password) {
    const value = String(password || "");
    return value.length >= 8 &&
      /[A-Z]/.test(value) &&
      /\d/.test(value) &&
      /[^A-Za-z0-9\s]/.test(value);
  }

  function populateChips(container, options, name, checkedByDefault) {
    if (!container) return;
    container.innerHTML = "";
    options.forEach(function (option) {
      const wrapper = document.createElement("label");
      wrapper.className = "chip" + (checkedByDefault ? " is-selected" : "");
      wrapper.innerHTML =
        '<input type="checkbox" name="' + name + '" value="' + option.id + '"' + (checkedByDefault ? " checked" : "") + ">" +
        '<span class="chip-label">' + option.label + "</span>";
      container.appendChild(wrapper);
    });
  }

  function populateProvinceChips(container) {
    if (!container) return;
    container.innerHTML = "";
    PROVINCIAS.forEach(function (province) {
      const wrapper = document.createElement("label");
      wrapper.className = "chip";
      wrapper.innerHTML =
        '<input type="checkbox" name="provincias" value="' + province + '">' +
        '<span class="chip-label">' + province + "</span>";
      container.appendChild(wrapper);
    });
  }

  function bindChipSelection(root) {
    root.addEventListener("change", function (event) {
      const input = event.target;
      if (!input || input.type !== "checkbox") return;
      const chip = input.closest(".chip");
      if (chip) {
        chip.classList.toggle("is-selected", input.checked);
      }
    });
  }

  function initRegisterPage() {
    const stepElements = Array.from(document.querySelectorAll(".step"));
    const stepLabel = byId("stepLabel");
    const stepHelper = byId("stepHelper");
    const progressBar = byId("progressBar");
    const notice = byId("formNotice");
    const verificationNotice = byId("verificationNotice");
    const registerButton = byId("registerSubmit");
    const verifyButton = byId("verifySubmit");
    const resendButton = byId("verifyResend");

    const formState = {
      currentStep: 1,
      totalSteps: 4,
      verificationPhone: null
    };

    const stepCopy = {
      1: "Plan y datos basicos",
      2: "Actividad y avisos",
      3: "Seguridad y telefono",
      4: "Verificacion final"
    };

    populateProvinceChips(byId("provinceList"));
    populateChips(byId("subsectorList"), SUBSECTORES, "subsectores", false);
    populateChips(byId("alertTypeList"), TIPOS_ALERTA, "tipos_alerta", true);
    bindChipSelection(document.body);

    document.querySelectorAll(".plan-card input").forEach(function (input) {
      input.addEventListener("change", function () {
        document.querySelectorAll(".plan-card").forEach(function (card) {
          card.classList.toggle("is-selected", card.contains(input) && input.checked);
        });
      });
    });

    byId("toStep2").addEventListener("click", function () {
      if (!validateStep1()) return;
      goToStep(2);
    });

    byId("backTo1").addEventListener("click", function () {
      goToStep(1);
    });

    byId("toStep3").addEventListener("click", function () {
      if (!validateStep2()) return;
      goToStep(3);
    });

    byId("backTo2").addEventListener("click", function () {
      goToStep(2);
    });

    byId("toggleOptional").addEventListener("click", function () {
      byId("optionalBox").classList.toggle("hidden");
    });

    registerButton.addEventListener("click", async function () {
      if (!validateStep3()) return;

      registerButton.disabled = true;
      setNotice(notice, "Estamos creando tu cuenta y preparando la verificacion por WhatsApp...", "info");

      const prefix = byId("registerPhonePrefix").value;
      const phone = normalizePhone(prefix, byId("registerPhone").value);
      const firstName = byId("firstName").value.trim();
      const lastName1 = byId("lastName1").value.trim();
      const lastName2 = byId("lastName2").value.trim();
      const fullName = [firstName, lastName1, lastName2].filter(Boolean).join(" ");

      const selectedAlertTypes = {};
      TIPOS_ALERTA.forEach(function (type) {
        selectedAlertTypes[type.id] = Boolean(document.querySelector('input[name="tipos_alerta"][value="' + type.id + '"]')?.checked);
      });

      const selectedSectors = Array.from(document.querySelectorAll('input[name="sector"]:checked')).map(function (input) {
        return input.value;
      });

      const payload = {
        phone: phone,
        name: fullName,
        first_name: firstName,
        last_name_1: lastName1,
        last_name_2: lastName2,
        email: byId("email").value.trim().toLowerCase(),
        password: byId("registerPassword").value,
        subscription: document.querySelector('input[name="subscription"]:checked')?.value || "agricultor",
        preferences: {
          provincias: Array.from(document.querySelectorAll('input[name="provincias"]:checked')).map(function (input) {
            return input.value;
          }),
          sectores: selectedSectors,
          subsectores: Array.from(document.querySelectorAll('input[name="subsectores"]:checked')).map(function (input) {
            return input.value;
          }),
          tipos_alerta: selectedAlertTypes
        },
        preferencias_extra: byId("extraPreferences").value.trim()
      };

      try {
        const response = await fetch(API_BASE + "/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });

        const body = await response.json();

        if (!response.ok || !body.success) {
          setNotice(notice, body.error || "No hemos podido crear la cuenta.", "error");
          return;
        }

        formState.verificationPhone = phone;
        byId("verifyPhoneHint").textContent = formatPhoneForHumans(phone);
        setNotice(notice, "", "");
        goToStep(4);
      } catch (error) {
        setNotice(notice, "Ha fallado la conexion. Intentalo de nuevo en unos segundos.", "error");
      } finally {
        registerButton.disabled = false;
      }
    });

    verifyButton.addEventListener("click", async function () {
      const code = byId("verificationCode").value.trim();
      if (code.length < 6) {
        setNotice(verificationNotice, "Escribe el codigo completo de 6 digitos.", "error");
        return;
      }

      verifyButton.disabled = true;
      setNotice(verificationNotice, "Estamos verificando tu telefono...", "info");

      try {
        const response = await fetch(API_BASE + "/verify-phone", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            phone: formState.verificationPhone,
            code: code
          })
        });

        const body = await response.json();

        if (!response.ok || !body.success) {
          setNotice(verificationNotice, body.error || "No hemos podido verificar el codigo.", "error");
          return;
        }

        setNotice(verificationNotice, "Cuenta activada. Ya puedes entrar a tu panel.", "success");
        window.setTimeout(function () {
          window.location.href = "/login/";
        }, 1200);
      } catch (error) {
        setNotice(verificationNotice, "Ha fallado la conexion. Intentalo otra vez.", "error");
      } finally {
        verifyButton.disabled = false;
      }
    });

    resendButton.addEventListener("click", async function () {
      if (!formState.verificationPhone) return;
      resendButton.disabled = true;
      setNotice(verificationNotice, "Estamos reenviando el codigo a tu WhatsApp...", "info");

      try {
        await fetch(API_BASE + "/verify-phone/request", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phone: formState.verificationPhone })
        });
        setNotice(verificationNotice, "Te hemos reenviado un nuevo codigo.", "success");
      } catch (error) {
        setNotice(verificationNotice, "No hemos podido reenviar el codigo. Prueba de nuevo.", "error");
      } finally {
        resendButton.disabled = false;
      }
    });

    function validateStep1() {
      const firstName = byId("firstName").value.trim();
      const lastName1 = byId("lastName1").value.trim();
      const email = byId("email").value.trim();

      if (firstName.length < 2) {
        setNotice(notice, "Necesitamos al menos tu nombre.", "error");
        return false;
      }

      if (lastName1.length < 2) {
        setNotice(notice, "Necesitamos al menos tu primer apellido.", "error");
        return false;
      }

      if (!isValidEmail(email)) {
        setNotice(notice, "Escribe un correo valido para poder ayudarte si hace falta.", "error");
        return false;
      }

      setNotice(notice, "", "");
      return true;
    }

    function validateStep2() {
      const selectedProvinces = document.querySelectorAll('input[name="provincias"]:checked').length;
      const selectedSector = document.querySelectorAll('input[name="sector"]:checked').length;
      const selectedSubsector = document.querySelectorAll('input[name="subsectores"]:checked').length;

      if (!selectedProvinces) {
        setNotice(notice, "Elige al menos una provincia para afinar las alertas.", "error");
        return false;
      }

      if (!selectedSector) {
        setNotice(notice, "Selecciona si eres agricultor, ganadero o mixto.", "error");
        return false;
      }

      if (!selectedSubsector) {
        setNotice(notice, "Elige al menos un subsector para que lo que recibas sea util.", "error");
        return false;
      }

      setNotice(notice, "", "");
      return true;
    }

    function validateStep3() {
      const password = byId("registerPassword").value;
      const passwordRepeat = byId("registerPasswordConfirm").value;
      const phone = normalizePhone(byId("registerPhonePrefix").value, byId("registerPhone").value);

      if (String(phone).length < 11) {
        setNotice(notice, "Escribe un telefono movil valido.", "error");
        return false;
      }

      if (!passwordCumplePolitica(password)) {
        setNotice(notice, PASSWORD_POLICY_MESSAGE, "error");
        return false;
      }

      if (password !== passwordRepeat) {
        setNotice(notice, "Las dos contrasenas no coinciden.", "error");
        return false;
      }

      setNotice(notice, "", "");
      return true;
    }

    function goToStep(stepNumber) {
      formState.currentStep = stepNumber;
      stepElements.forEach(function (element) {
        element.classList.toggle("is-active", Number(element.dataset.step) === stepNumber);
      });
      stepLabel.textContent = "Paso " + stepNumber + " de " + formState.totalSteps;
      stepHelper.textContent = stepCopy[stepNumber];
      progressBar.style.width = (stepNumber / formState.totalSteps) * 100 + "%";
      window.scrollTo({ top: 0, behavior: "smooth" });
    }

    goToStep(1);
  }

  function initLoginPage() {
    const notice = byId("loginNotice");
    const verifyBox = byId("loginVerifyBox");
    const verifyNotice = byId("loginVerifyNotice");
    const loginButton = byId("loginSubmit");
    const verifyButton = byId("loginVerifySubmit");
    const resendButton = byId("loginVerifyResend");
    let pendingPhone = null;

    loginButton.addEventListener("click", async function () {
      const phone = normalizePhone(byId("loginPhonePrefix").value, byId("loginPhone").value);
      const password = byId("loginPassword").value;

      if (String(phone).length < 11) {
        setNotice(notice, "Escribe el telefono con el que te registraste.", "error");
        return;
      }

      if (!password) {
        setNotice(notice, "Escribe tu contrasena.", "error");
        return;
      }

      loginButton.disabled = true;
      setNotice(notice, "Comprobando tus datos...", "info");

      try {
        const response = await fetch(API_BASE + "/login-phone", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phone: phone, password: password })
        });

        const body = await response.json();

        if (response.ok && body.token) {
          window.localStorage.setItem(STORAGE_TOKEN_KEY, body.token);
          setNotice(notice, "Acceso correcto. Entrando a tu cuenta...", "success");
          window.setTimeout(function () {
            window.location.href = "/cuenta/";
          }, 700);
          return;
        }

        if (response.status === 403 && body.code === "phone_unverified") {
          pendingPhone = body.phone || phone;
          verifyBox.classList.remove("hidden");
          byId("loginVerifyPhoneHint").textContent = formatPhoneForHumans(pendingPhone);
          setNotice(notice, "Tu cuenta existe, pero falta verificar el telefono.", "info");
          return;
        }

        setNotice(notice, body.error || "No hemos podido iniciar sesion.", "error");
      } catch (error) {
        setNotice(notice, "Ha fallado la conexion. Intentalo de nuevo.", "error");
      } finally {
        loginButton.disabled = false;
      }
    });

    verifyButton.addEventListener("click", async function () {
      const code = byId("loginVerifyCode").value.trim();
      if (!pendingPhone || code.length < 6) {
        setNotice(verifyNotice, "Escribe el codigo de 6 digitos para activar tu cuenta.", "error");
        return;
      }

      verifyButton.disabled = true;
      setNotice(verifyNotice, "Verificando codigo...", "info");

      try {
        const response = await fetch(API_BASE + "/verify-phone", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phone: pendingPhone, code: code })
        });

        const body = await response.json();

        if (!response.ok || !body.success) {
          setNotice(verifyNotice, body.error || "No hemos podido verificar el codigo.", "error");
          return;
        }

        setNotice(verifyNotice, "Telefono verificado. Ya puedes entrar.", "success");
      } catch (error) {
        setNotice(verifyNotice, "Ha fallado la conexion. Intentalo otra vez.", "error");
      } finally {
        verifyButton.disabled = false;
      }
    });

    resendButton.addEventListener("click", async function () {
      if (!pendingPhone) return;
      resendButton.disabled = true;
      setNotice(verifyNotice, "Reenviando codigo...", "info");

      try {
        await fetch(API_BASE + "/verify-phone/request", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phone: pendingPhone })
        });
        setNotice(verifyNotice, "Te hemos reenviado un nuevo codigo.", "success");
      } catch (error) {
        setNotice(verifyNotice, "No hemos podido reenviar el codigo.", "error");
      } finally {
        resendButton.disabled = false;
      }
    });
  }

  function initRecoverPage() {
    const requestButton = byId("recoverRequestSubmit");
    const verifyButton = byId("recoverVerifySubmit");
    const requestNotice = byId("recoverRequestNotice");
    const verifyNotice = byId("recoverVerifyNotice");
    const verifyBox = byId("recoverVerifyBox");
    let resetPhone = null;

    requestButton.addEventListener("click", async function () {
      const phone = normalizePhone(byId("recoverPhonePrefix").value, byId("recoverPhone").value);
      if (String(phone).length < 11) {
        setNotice(requestNotice, "Escribe tu telefono para enviarte el codigo por WhatsApp.", "error");
        return;
      }

      requestButton.disabled = true;
      setNotice(requestNotice, "Preparando tu codigo de recuperacion...", "info");

      try {
        const response = await fetch(API_BASE + "/password-reset", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phone: phone })
        });

        const body = await response.json();
        if (!response.ok) {
          setNotice(requestNotice, body.error || "No hemos podido iniciar la recuperacion.", "error");
          return;
        }

        resetPhone = phone;
        verifyBox.classList.remove("hidden");
        byId("recoverVerifyPhoneHint").textContent = formatPhoneForHumans(phone);
        setNotice(requestNotice, "Si tu cuenta existe, te acabamos de enviar un codigo por WhatsApp.", "success");
      } catch (error) {
        setNotice(requestNotice, "Ha fallado la conexion. Intentalo de nuevo.", "error");
      } finally {
        requestButton.disabled = false;
      }
    });

    verifyButton.addEventListener("click", async function () {
      const code = byId("recoverCode").value.trim();
      const password = byId("recoverPassword").value;
      const confirm = byId("recoverPasswordConfirm").value;

      if (!resetPhone) {
        setNotice(verifyNotice, "Primero tienes que pedir el codigo.", "error");
        return;
      }

      if (code.length < 6) {
        setNotice(verifyNotice, "Escribe el codigo completo.", "error");
        return;
      }

      if (!passwordCumplePolitica(password)) {
        setNotice(verifyNotice, PASSWORD_POLICY_MESSAGE, "error");
        return;
      }

      if (password !== confirm) {
        setNotice(verifyNotice, "Las dos contrasenas no coinciden.", "error");
        return;
      }

      verifyButton.disabled = true;
      setNotice(verifyNotice, "Actualizando tu contrasena...", "info");

      try {
        const response = await fetch(API_BASE + "/password-reset/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            phone: resetPhone,
            code: code,
            password: password
          })
        });

        const body = await response.json();
        if (!response.ok || !body.success) {
          setNotice(verifyNotice, body.error || "No hemos podido cambiar la contrasena.", "error");
          return;
        }

        setNotice(verifyNotice, "Contrasena actualizada. Ya puedes volver al login.", "success");
        window.setTimeout(function () {
          window.location.href = "/login/";
        }, 1200);
      } catch (error) {
        setNotice(verifyNotice, "Ha fallado la conexion. Prueba otra vez.", "error");
      } finally {
        verifyButton.disabled = false;
      }
    });
  }

  function initAccountPage() {
    const token = window.localStorage.getItem(STORAGE_TOKEN_KEY);
    const notice = byId("accountNotice");
    const content = byId("accountContent");
    const verifyBox = byId("accountVerifyBox");
    const verifyNotice = byId("accountVerifyNotice");
    const logoutButton = byId("logoutButton");
    const resendButton = byId("accountVerifyResend");
    const verifyButton = byId("accountVerifySubmit");
    let currentPhone = null;

    if (!token) {
      window.location.href = "/login/";
      return;
    }

    logoutButton.addEventListener("click", function () {
      window.localStorage.removeItem(STORAGE_TOKEN_KEY);
      window.location.href = "/login/";
    });

    verifyButton.addEventListener("click", async function () {
      const code = byId("accountVerifyCode").value.trim();
      if (!currentPhone || code.length < 6) {
        setNotice(verifyNotice, "Escribe el codigo de 6 digitos.", "error");
        return;
      }

      verifyButton.disabled = true;
      setNotice(verifyNotice, "Verificando codigo...", "info");

      try {
        const response = await fetch(API_BASE + "/me/verify-phone", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + token
          },
          body: JSON.stringify({ code: code })
        });

        const body = await response.json();
        if (!response.ok || !body.ok) {
          setNotice(verifyNotice, body.error || "No hemos podido verificar el telefono.", "error");
          return;
        }
        setNotice(verifyNotice, "Telefono verificado correctamente.", "success");
        verifyBox.classList.add("hidden");
        loadAccount();
      } catch (error) {
        setNotice(verifyNotice, "Ha fallado la conexion. Intentalo de nuevo.", "error");
      } finally {
        verifyButton.disabled = false;
      }
    });

    resendButton.addEventListener("click", async function () {
      if (!currentPhone) return;
      resendButton.disabled = true;
      setNotice(verifyNotice, "Reenviando codigo...", "info");
      try {
        await fetch(API_BASE + "/verify-phone/request", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phone: currentPhone })
        });
        setNotice(verifyNotice, "Codigo reenviado a tu WhatsApp.", "success");
      } catch (error) {
        setNotice(verifyNotice, "No hemos podido reenviar el codigo.", "error");
      } finally {
        resendButton.disabled = false;
      }
    });

    loadAccount();

    async function loadAccount() {
      setNotice(notice, "Cargando tu cuenta...", "info");
      try {
        const response = await fetch(API_BASE + "/me", {
          headers: { "Authorization": "Bearer " + token }
        });
        const body = await response.json();

        if (!response.ok || !body.user) {
          window.localStorage.removeItem(STORAGE_TOKEN_KEY);
          window.location.href = "/login/";
          return;
        }

        currentPhone = body.user.phone;
        renderAccount(body.user);
        setNotice(notice, "", "");
      } catch (error) {
        setNotice(notice, "No hemos podido cargar tu cuenta ahora mismo.", "error");
      }
    }

    function renderAccount(user) {
      content.innerHTML =
        '<div class="aside-list">' +
          buildSummaryItem("Nombre", user.legal_name || user.name || "-") +
          buildSummaryItem("Plan", normalizePlan(user.subscription)) +
          buildSummaryItem("Telefono", formatPhoneForHumans(user.phone || "-")) +
          buildSummaryItem("Email", user.email || "Aun no configurado") +
        "</div>";

      if (user.phone_verified === false) {
        verifyBox.classList.remove("hidden");
        byId("accountVerifyPhoneHint").textContent = formatPhoneForHumans(user.phone || "");
      } else {
        verifyBox.classList.add("hidden");
      }
    }
  }

  function buildSummaryItem(label, value) {
    return "<li><strong>" + label + "</strong><span>" + value + "</span></li>";
  }

  function normalizePlan(plan) {
    if (plan === "agricultor") return "Plan Agricultor";
    if (plan === "cooperativa") return "Plan Cooperativa";
    return "Plan Corral";
  }

  function formatPhoneForHumans(phone) {
    const digits = String(phone || "").replace(/\D/g, "");
    if (digits.length === 11 && digits.startsWith("34")) {
      return "+34 " + digits.slice(2, 5) + " " + digits.slice(5, 8) + " " + digits.slice(8, 11);
    }
    return phone;
  }

  function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
  }
})();
