/* ==========================================================================
   muaban.vin — app.js (ethers v5)
   Yêu cầu: index.html đã nạp ethers@5.7.2 UMD và file này bằng <script defer src="app.js">
   ========================================================================== */

/* -------------------- 0) Hằng số & tiện ích -------------------- */
const VIC_CHAIN_ID_DEC = 88;
const VIC_CHAIN_ID_HEX = "0x58"; // 88
const VIC_RPC = "https://rpc.viction.xyz";
const VIC_EXPLORER = "https://vicscan.xyz";

const MUABAN_ADDR = "0x190FD18820498872354eED9C4C080cB365Cd12E0"; // MuabanVND
const VIN_ADDR     = "0x941F63807401efCE8afe3C9d88d368bAA287Fac4"; // VIN (VIC)

const BINANCE_VICUSDT = "https://api.binance.com/api/v3/ticker/price?symbol=VICUSDT";
const COINGECKO_FIAT  = "https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=vnd";

// Ngưỡng quét tối đa (tránh quét vô hạn). Có thể điều chỉnh tùy dữ liệu thực tế.
const MAX_SCAN_PRODUCTS = 4000;
const MAX_SCAN_ORDERS   = 4000;
// Số lượng "trống liên tiếp" để dừng quét (gặp nhiều pid/oid rỗng liên tục thì dừng)
const EMPTY_STREAK_STOP = 50;

// DOM helper
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// Toast đơn giản
function toast(msg, type = "info") {
  console.log(`[${type}]`, msg);
  alert(msg);
}

// Rút gọn địa chỉ
function shortAddr(a) {
  return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "0x…";
}
// Thêm helper này vào đầu file (gần các tiện ích khác)
function decodeRpcError(e) {
  // Cố gắng lôi revert reason từ nhiều nơi khác nhau
  const msg = e?.data?.message || e?.error?.message || e?.message || "";
  if (msg) return msg;

  // Một số provider trả về {data: {originalError: {data: '0x...', message:'...'}}}
  const oerr = e?.data?.originalError || e?.error?.data || e?.data;
  if (typeof oerr === "string") return oerr;
  if (oerr && oerr.message) return oerr.message;
  try {
    return JSON.stringify(e);
  } catch {
    return "Unknown error";
  }
}

// BigNumber helper (ethers v5)
const { ethers } = window;

/* -------------------- 1) Trạng thái toàn cục -------------------- */
let provider;          // Web3Provider (MetaMask)
let signer;            // signer
let account;           // địa chỉ ví người dùng
let muaban;            // contract MuabanVND
let vin;               // contract VIN (ERC20)

let vinPriceVND = null;   // 1 VIN = ? VND (integer)
let vinPerVND_wei = null; // VIN wei per 1 VND (ceil(1e18 / vinPriceVND))

// bộ nhớ cache dữ liệu
const state = {
  registered: false,
  products: [], // danh sách product đã tải
  orders:   [], // danh sách orders đã tải
};

/* -------------------- 2) Tải ABI (đã đóng gói cùng repo) -------------------- */
/* Lưu ý: index.html đã cùng thư mục chứa các JSON ABI bạn gửi (Muaban_ABI.json, VinToken_ABI.json) */
async function loadABIs() {
  // Dùng fetch local (gh-pages) — không gọi mạng ngoài domain khác
  const [muabanAbi, vinAbi] = await Promise.all([
    fetch("Muaban_ABI.json", { cache: "no-store" }).then(r => r.json()),
    fetch("VinToken_ABI.json", { cache: "no-store" }).then(r => r.json()),
  ]);
  return { muabanAbi, vinAbi };
}

/* -------------------- 3) Kết nối mạng & ví -------------------- */
async function ensureVictionAfterUnlock() {
  const eth = window.ethereum;
  if (!eth) throw new Error("Vui lòng cài MetaMask.");

  const chainId = await eth.request({ method: "eth_chainId" });
  if (chainId === VIC_CHAIN_ID_HEX) return;

  try {
    await eth.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: VIC_CHAIN_ID_HEX }],
    });
  } catch (err) {
    if (err && err.code === 4902) {
      // Chưa có chain → add
      await eth.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: VIC_CHAIN_ID_HEX,
          chainName: "Viction Mainnet",
          nativeCurrency: { name: "VIC", symbol: "VIC", decimals: 18 },
          rpcUrls: [VIC_RPC],
          blockExplorerUrls: [VIC_EXPLORER],
        }],
      });
    } else {
      throw err;
    }
  }
}

async function connectWallet() {
  const eth = window.ethereum;
  if (!eth) { toast("Vui lòng cài MetaMask.", "error"); return; }

  // Yêu cầu quyền truy cập tài khoản
  const accs = await eth.request({ method: "eth_requestAccounts" });
  if (!accs || !accs.length) throw new Error("Không có tài khoản MetaMask.");

  // Đảm bảo đúng chain
  await ensureVictionAfterUnlock();

  provider = new ethers.providers.Web3Provider(eth);
  signer   = provider.getSigner();
  account  = await signer.getAddress();

  // Khởi tạo contract
  const { muabanAbi, vinAbi } = await loadABIs();
  muaban = new ethers.Contract(MUABAN_ADDR, muabanAbi, signer);
  vin    = new ethers.Contract(VIN_ADDR, vinAbi, signer);

  // Cập nhật giao diện
  await refreshAccountUI();
  await refreshMenuByRegistration();
  await loadProducts(); // tải danh sách sản phẩm
  // Tải đơn hàng (tùy chọn, có thể để người dùng bấm mới tải)
  // await loadOrdersAll(); // nếu muốn tự động
}

function disconnectWalletUI() {
  provider = undefined;
  signer = undefined;
  account = undefined;
  muaban = undefined;
  vin = undefined;

  $("#walletBox").classList.add("hidden");
  $("#btnConnect").classList.remove("hidden");
  $("#menuBox").classList.add("hidden");
}

/* -------------------- 4) Giá VIN theo VND -------------------- */
/**
 * Tính 1 VIN = ? VND
 * VIN/VND = (VIC/USDT từ Binance × 100) × (USDT/VND từ CoinGecko)
 * Làm tròn xuống integer.
 */
async function fetchVinPriceVND() {
  try {
    const [res1, res2] = await Promise.all([
      fetch(BINANCE_VICUSDT, { cache: "no-store" }).then(r => r.json()),
      fetch(COINGECKO_FIAT,  { cache: "no-store" }).then(r => r.json()),
    ]);
    const vic_usdt = Number(res1?.price || 0);
    const usdt_vnd = Number(res2?.tether?.vnd || 0);

    if (!vic_usdt || !usdt_vnd) throw new Error("Không lấy được giá VIC/USDT hoặc USDT/VND.");

    const vin_vnd = Math.floor(vic_usdt * 100 * usdt_vnd);
    vinPriceVND = vin_vnd > 0 ? vin_vnd : null;

    if (vinPriceVND) {
      // vinPerVND_wei = ceil(1e18 / vinPriceVND)
      const ONE = ethers.BigNumber.from("1000000000000000000");
      const vndBN = ethers.BigNumber.from(String(vinPriceVND));
      vinPerVND_wei = ONE.add(vndBN).sub(1).div(vndBN);
    } else {
      vinPerVND_wei = null;
    }

    updateVinPriceChip();
  } catch (e) {
    console.warn("[price] error:", e);
    $("#vinPrice").textContent = "Loading price...";
  }
}

function updateVinPriceChip() {
  const chip = $("#vinPrice");
  if (!chip) return;
  if (!vinPriceVND) {
    chip.textContent = "Loading price...";
    return;
  }
  // hiển thị hàng nghìn
  const vn = new Intl.NumberFormat("vi-VN").format(vinPriceVND);
  chip.textContent = `1 VIN = ${vn} VND`;
}

/* -------------------- 5) Cập nhật UI ví/số dư -------------------- */
async function refreshAccountUI() {
  if (!provider || !signer || !account) return;

  $("#btnConnect").classList.add("hidden");
  const wbox = $("#walletBox");
  wbox.classList.remove("hidden");

  // Số dư VIC
  const balVIC = await provider.getBalance(account);
  $("#vicBalance").textContent = `VIC: ${ethers.utils.formatUnits(balVIC, 18)}`;

  // Số dư VIN
  const balVIN = await vin.balanceOf(account);
  $("#vinBalance").textContent = `VIN: ${ethers.utils.formatUnits(balVIN, 18)}`;

  // Link explorer
  const a = $("#accountShort");
  a.textContent = shortAddr(account);
  a.href = `${VIC_EXPLORER}/address/${account}`;
}

/* -------------------- 6) Kiểm tra đăng ký & Menu -------------------- */
async function isRegistered(addr) {
  try {
    const reg = await muaban.registered(addr);
    return !!reg;
  } catch {
    return false;
  }
}

async function refreshMenuByRegistration() {
  if (!account || !muaban) {
    $("#menuBox").classList.add("hidden");
    return;
  }

  state.registered = await isRegistered(account);

  const menu = $("#menuBox");
  menu.classList.remove("hidden");

  const btnReg    = $("#btnRegister");
  const btnCreate = $("#btnCreate");
  const btnOB     = $("#btnOrdersBuy");
  const btnOS     = $("#btnOrdersSell");

  if (!state.registered) {
    // chỉ hiện nút đăng ký
    btnReg.classList.remove("hidden");
    btnCreate.classList.add("hidden");
    btnOB.classList.add("hidden");
    btnOS.classList.add("hidden");
  } else {
    btnReg.classList.add("hidden");
    btnCreate.classList.remove("hidden");
    btnOB.classList.remove("hidden");
    btnOS.classList.remove("hidden");
  }
}

/* -------------------- 7) Đăng ký ví (0.001 VIN) -------------------- */
async function registerWallet() {
  try {
    if (!vin || !muaban) { toast("Chưa kết nối ví.", "error"); return; }

    // 0.001 VIN = 1e15 wei
    const REG_FEE = ethers.BigNumber.from("1000000000000000");

    // Kiểm tra allowance
    const allowance = await vin.allowance(account, MUABAN_ADDR);
    if (allowance.lt(REG_FEE)) {
      const tx1 = await vin.approve(MUABAN_ADDR, REG_FEE.mul(2)); // dư một chút
      await tx1.wait();
    }

    // Gọi payRegistration()
    // ước lượng gas
    const gas = await muaban.estimateGas.payRegistration().catch(() => ethers.BigNumber.from(300000));
    const tx2 = await muaban.payRegistration({ gasLimit: gas.mul(13).div(10) });
    await tx2.wait();

    toast("Đăng ký thành công!");
    await refreshMenuByRegistration();
    await refreshAccountUI();
  } catch (e) {
    console.error("registerWallet error:", e);
    toast(`Đăng ký thất bại: ${e?.data?.message || e?.error?.message || e?.message || "Unknown error"}`, "error");
  }
}

/* -------------------- 8) Đăng sản phẩm -------------------- */
function openModal(id) {
  const m = $(id);
  if (!m) return;
  m.classList.remove("hidden");
  document.body.classList.add("no-scroll");
}

function closeModals() {
  $$(".modal").forEach(m => m.classList.add("hidden"));
  document.body.classList.remove("no-scroll");
}

async function submitCreate() {
  try {
    if (!state.registered) { toast("Bạn cần đăng ký trước khi đăng sản phẩm."); return; }

    const name   = ($("#createName").value || "").trim();
    const ipfs   = ($("#createIPFS").value || "").trim();
    const unit   = ($("#createUnit").value || "").trim();
    const priceVNDStr = ($("#createPrice").value || "").trim().replace(/[,.\s]/g, "");
    const wallet = ($("#createWallet").value || "").trim();
    const days   = Number($("#createDays").value || 0);

    // ----- Validate input kỹ hơn -----
    if (!name) { toast("Tên sản phẩm không được để trống."); return; }
    if (!ipfs) { toast("Vui lòng nhập IPFS CID của hình/video."); return; }
    if (!unit) { toast("Vui lòng nhập đơn vị bán (ví dụ: cái, hộp…)."); return; }

    if (!priceVNDStr || !/^\d+$/.test(priceVNDStr)) {
      toast("Giá VND phải là số nguyên dương (không chứa dấu phẩy/chấm)."); return;
    }
    const priceVND = ethers.BigNumber.from(priceVNDStr);
    if (priceVND.lte(0)) { toast("Giá VND phải > 0."); return; }

    if (!ethers.utils.isAddress(wallet) || wallet === ethers.constants.AddressZero) {
      toast("Địa chỉ ví nhận tiền (payout) không hợp lệ."); return;
    }
    if (!Number.isFinite(days) || days <= 0 || days > 3650) {
      toast("Số ngày giao tối đa phải trong khoảng 1…3650."); return;
    }

    const descriptionCID = `unit:${unit}`;
    const imageCID = ipfs;
    const active = true;

    // ----- Pre-flight: callStatic để bắt revert reason rõ ràng -----
    try {
      await muaban.callStatic.createProduct(
        name, descriptionCID, imageCID, priceVND, days, wallet, active
      );
    } catch (simErr) {
      const reason = decodeRpcError(simErr);
      // Bóc tách vài thông điệp thường gặp để hiển thị thân thiện
      if (reason.includes("NOT_REGISTERED"))  toast("Ví của bạn chưa đăng ký. Vui lòng bấm 'Đăng ký' (0.001 VIN).", "error");
      else if (reason.includes("PRICE_REQUIRED"))  toast("Giá VND phải > 0.", "error");
      else if (reason.includes("DELIVERY_REQUIRED"))  toast("Số ngày giao tối đa phải > 0.", "error");
      else if (reason.includes("PAYOUT_WALLET_ZERO")) toast("Địa chỉ ví nhận tiền không hợp lệ.", "error");
      else toast(`Đăng sản phẩm bị từ chối: ${reason}`, "error");
      return; // Không gửi tx khi mô phỏng đã fail
    }

    // ----- Ước lượng gas rồi gửi thật -----
    let gas;
    try {
      gas = await muaban.estimateGas.createProduct(
        name, descriptionCID, imageCID, priceVND, days, wallet, active
      );
    } catch (egErr) {
      // Nếu ước lượng gas cũng fail, hiển thị lỗi chi tiết và dừng
      const reason = decodeRpcError(egErr);
      toast(`Không ước lượng được gas: ${reason}`, "error");
      return;
    }

    const tx = await muaban.createProduct(
      name, descriptionCID, imageCID, priceVND, days, wallet, active,
      { gasLimit: gas.mul(13).div(10) } // +30% buffer
    );
    await tx.wait();

    toast("Đăng sản phẩm thành công!");
    closeModals();
    await loadProducts(true);
  } catch (e) {
    console.error("submitCreate error:", e);
    toast(`Lỗi khi đăng sản phẩm: ${decodeRpcError(e) || "Internal JSON-RPC error."}`, "error");
  }
}

/* -------------------- 9) Tải & hiển thị sản phẩm -------------------- */
/**
 * Vì hợp đồng không có tổng số sản phẩm, ta quét tăng dần pid=1..N,
 * dừng khi gặp nhiều pid trống liên tiếp (EMPTY_STREAK_STOP) hoặc đạt MAX_SCAN_PRODUCTS.
 */
async function scanAllProducts() {
  if (!muaban) return [];

  const list = [];
  let emptyStreak = 0;

  for (let pid = 1; pid <= MAX_SCAN_PRODUCTS; pid++) {
    try {
      const p = await muaban.products(pid); // dùng getter mapping (xem ABI)
      const seller = p.seller;
      if (seller && seller !== ethers.constants.AddressZero) {
        emptyStreak = 0;
        list.push({
          productId: p.productId.toNumber ? p.productId.toNumber() : Number(p.productId),
          seller,
          name: p.name,
          descriptionCID: p.descriptionCID,
          imageCID: p.imageCID,
          priceVND: p.priceVND,
          deliveryDaysMax: p.deliveryDaysMax,
          payoutWallet: p.payoutWallet,
          active: p.active,
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
        });
      } else {
        emptyStreak++;
      }
    } catch {
      emptyStreak++;
    }
    if (emptyStreak >= EMPTY_STREAK_STOP) break;
  }
  // Sắp xếp mới nhất lên trước
  list.sort((a, b) => (Number(b.productId) - Number(a.productId)));
  return list;
}

function parseUnitFromDescription(desc) {
  if (!desc) return "";
  const m = /^unit:(.+)$/i.exec(desc.trim());
  return m ? m[1] : "";
}

function vndFormat(n) {
  return new Intl.NumberFormat("vi-VN").format(Number(n));
}

function renderProductCard(p) {
  const unit = parseUnitFromDescription(p.descriptionCID);
  const img = (p.imageCID || "").startsWith("ipfs://")
    ? p.imageCID.replace("ipfs://", "https://ipfs.io/ipfs/")
    : p.imageCID;

  const meIsSeller = account && account.toLowerCase() === p.seller.toLowerCase();

  const actions = [];
  if (p.active) {
    if (account) {
      if (meIsSeller) {
        actions.push(`<button class="btn" data-act="update" data-id="${p.productId}">Cập nhật sản phẩm</button>`);
      } else {
        actions.push(`<button class="btn primary" data-act="buy" data-id="${p.productId}">Mua</button>`);
      }
    }
  } else {
    actions.push(`<span class="badge">Hết hàng</span>`);
  }

  return `
  <article class="product-card" data-pid="${p.productId}">
    <img class="product-thumb" src="${img}" alt="">
    <div class="product-info">
      <div class="product-top">
        <h3 class="product-title">${p.name}</h3>
        <span class="tag mono">#${p.productId}</span>
      </div>
      <div class="product-meta">
        <span class="price-vnd">${vndFormat(p.priceVND)} VND</span>
        ${unit ? `<span class="unit">/ ${unit}</span>` : ""}
        <span class="stock-badge ${p.active ? "" : "out"}">${p.active ? "Còn hàng" : "Hết hàng"}</span>
      </div>
      <div class="card-actions">
        ${actions.join(" ")}
      </div>
    </div>
  </article>`;
}

function renderProducts(list) {
  const box = $("#productList");
  if (!box) return;
  if (!list.length) {
    box.innerHTML = `<div class="tag">Chưa có sản phẩm.</div>`;
    return;
  }
  box.innerHTML = list.map(renderProductCard).join("");

  // Gán sự kiện nút trong card
  $$("#productList [data-act]").forEach(btn => {
    const act = btn.getAttribute("data-act");
    const pid = Number(btn.getAttribute("data-id"));
    if (act === "buy") {
      btn.addEventListener("click", () => openBuyModal(pid));
    } else if (act === "update") {
      btn.addEventListener("click", () => openUpdateModal(pid));
    }
  });
}

async function loadProducts(forceReload = false) {
  if (!muaban) return;
  if (!forceReload && state.products.length) {
    renderProducts(state.products);
    return;
  }
  const list = await scanAllProducts();
  state.products = list;
  renderProducts(list);
}

/* -------------------- 10) Mua sản phẩm -------------------- */
function encodeBuyerInfo(obj) {
  // “mã hóa” tối thiểu theo yêu cầu UI — base64 JSON (không bảo mật mạnh)
  try {
    return btoa(unescape(encodeURIComponent(JSON.stringify(obj))));
  } catch {
    return "";
  }
}

function decodeBuyerInfo(s) {
  try {
    return JSON.parse(decodeURIComponent(escape(atob(s))));
  } catch {
    return null;
  }
}

let currentBuyPID = null;

async function openBuyModal(pid) {
  currentBuyPID = pid;
  const p = state.products.find(x => Number(x.productId) === Number(pid));
  if (!p) { toast("Không tìm thấy sản phẩm."); return; }

  $("#buyProductInfo").innerHTML = `
    <div><strong>${p.name}</strong></div>
    <div>Giá: <b>${vndFormat(p.priceVND)} VND</b></div>
  `;

  $("#buyQty").value = "1";
  updateBuyTotalVIN();

  openModal("#formBuy");
}

function updateBuyTotalVIN() {
  const qty = Math.max(1, Number($("#buyQty").value || 1));
  const p = state.products.find(x => Number(x.productId) === Number(currentBuyPID));
  if (!p || !vinPriceVND || !vinPerVND_wei) {
    $("#buyTotalVIN").textContent = `Tổng VIN cần trả: ...`;
    return;
  }
  const totalVND = ethers.BigNumber.from(String(p.priceVND)).mul(qty);
  const vinWei = totalVND.mul(vinPerVND_wei); // vì contract dùng ceil đã nằm ở vinPerVND_wei
  const vinHuman = ethers.utils.formatUnits(vinWei, 18);
  $("#buyTotalVIN").textContent = `Tổng VIN cần trả: ${vinHuman}`;
}

async function submitBuy() {
  try {
    if (!state.registered) { toast("Bạn cần đăng ký trước khi mua."); return; }
    if (!vinPriceVND || !vinPerVND_wei) { toast("Đang tải giá VIN. Vui lòng thử lại sau."); return; }

    const p = state.products.find(x => Number(x.productId) === Number(currentBuyPID));
    if (!p) { toast("Không tìm thấy sản phẩm."); return; }
    if (!p.active) { toast("Sản phẩm đã hết hàng."); return; }

    const name  = ($("#buyName").value || "").trim();
    const addr  = ($("#buyAddress").value || "").trim();
    const phone = ($("#buyPhone").value || "").trim();
    const note  = ($("#buyNote").value || "").trim();
    const qty   = Math.max(1, Number($("#buyQty").value || 1));

    if (!name || !addr || !phone) { toast("Vui lòng nhập Họ tên, Địa chỉ, SĐT."); return; }

    const buyerInfo = encodeBuyerInfo({ name, addr, phone, note });

    // Tính tổng VIN cần escrow
    const totalVND = ethers.BigNumber.from(String(p.priceVND)).mul(qty);
    const needVinWei = totalVND.mul(vinPerVND_wei);

    // Kiểm tra & approve đủ VIN cho hợp đồng
    const allowance = await vin.allowance(account, MUABAN_ADDR);
    if (allowance.lt(needVinWei)) {
      const tx1 = await vin.approve(MUABAN_ADDR, needVinWei.mul(11).div(10)); // approve dư 10%
      await tx1.wait();
    }

    // placeOrder(productId, quantity, vinPerVND, buyerInfoCipher)
    let gas;
    try {
      gas = await muaban.estimateGas.placeOrder(p.productId, qty, vinPerVND_wei, buyerInfo);
    } catch {
      gas = ethers.BigNumber.from(800000);
    }

    const tx2 = await muaban.placeOrder(
      p.productId,
      qty,
      vinPerVND_wei,
      buyerInfo,
      { gasLimit: gas.mul(13).div(10) }
    );
    await tx2.wait();

    toast("Đặt hàng thành công! VIN đã được ký gửi vào hợp đồng.");
    closeModals();
    await refreshAccountUI();
    // Có thể load lại orders nếu muốn
    // await loadOrdersAll(true);
  } catch (e) {
    console.error("submitBuy error:", e);
    toast(`Lỗi khi mua: ${e?.data?.message || e?.error?.message || e?.message || "Internal JSON-RPC error."}`, "error");
  }
}

/* -------------------- 11) Cập nhật sản phẩm -------------------- */
let currentUpdatePID = null;

async function openUpdateModal(pid) {
  currentUpdatePID = pid;
  const p = state.products.find(x => Number(x.productId) === Number(pid));
  if (!p) { toast("Không tìm thấy sản phẩm."); return; }

  // Chỉ seller được cập nhật
  if (!account || p.seller.toLowerCase() !== account.toLowerCase()) {
    toast("Chỉ người bán mới có quyền cập nhật sản phẩm."); return;
  }

  $("#updatePid").value = String(pid);
  $("#updatePrice").value = String(p.priceVND);
  $("#updateDays").value = String(p.deliveryDaysMax);
  $("#updateWallet").value = p.payoutWallet || "";
  $("#updateActive").checked = !!p.active;

  openModal("#formUpdate");
}

async function submitUpdate() {
  try {
    const pid = Number($("#updatePid").value);
    const p = state.products.find(x => Number(x.productId) === Number(pid));
    if (!p) { toast("Không tìm thấy sản phẩm."); return; }
    if (!account || p.seller.toLowerCase() !== account.toLowerCase()) {
      toast("Chỉ người bán mới có quyền cập nhật."); return;
    }

    const priceVNDNum = Math.max(1, Number($("#updatePrice").value || 0));
    const priceVND = ethers.BigNumber.from(String(priceVNDNum));
    const days = Math.max(1, Number($("#updateDays").value || 1));
    const wallet = ($("#updateWallet").value || "").trim();
    const active = !!$("#updateActive").checked;

    if (!priceVND || !wallet || !days) { toast("Thiếu dữ liệu cập nhật."); return; }

    let gas;
    try {
      gas = await muaban.estimateGas.updateProduct(pid, priceVND, days, wallet, active);
    } catch {
      gas = ethers.BigNumber.from(500000);
    }

    const tx = await muaban.updateProduct(
      pid, priceVND, days, wallet, active,
      { gasLimit: gas.mul(13).div(10) }
    );
    await tx.wait();

    toast("Cập nhật thành công!");
    closeModals();
    await loadProducts(true);
  } catch (e) {
    console.error("submitUpdate error:", e);
    toast(`Lỗi cập nhật: ${e?.data?.message || e?.error?.message || e?.message || "Internal JSON-RPC error."}`, "error");
  }
}

/* -------------------- 12) Đơn hàng (buyer/seller) -------------------- */
/**
 * Hợp đồng không có tổng số order => quét như sản phẩm
 */
async function scanAllOrders() {
  if (!muaban) return [];
  const list = [];
  let emptyStreak = 0;
  for (let oid = 1; oid <= MAX_SCAN_ORDERS; oid++) {
    try {
      const o = await muaban.orders(oid);
      const buyer = o.buyer;
      if (buyer && buyer !== ethers.constants.AddressZero && (o.status || 0) !== 0) {
        emptyStreak = 0;
        list.push({
          orderId: o.orderId.toNumber ? o.orderId.toNumber() : Number(o.orderId),
          productId: Number(o.productId),
          buyer,
          seller: o.seller,
          quantity: Number(o.quantity),
          vinAmount: o.vinAmount,
          placedAt: Number(o.placedAt),
          deadline: Number(o.deadline),
          status: Number(o.status),
          buyerInfoCipher: o.buyerInfoCipher || "",
        });
      } else {
        emptyStreak++;
      }
    } catch {
      emptyStreak++;
    }
    if (emptyStreak >= EMPTY_STREAK_STOP) break;
  }
  list.sort((a, b) => (Number(b.orderId) - Number(a.orderId)));
  return list;
}

function renderOrders() {
  const myBuy = [];
  const mySell = [];

  for (const o of state.orders) {
    if (account && o.buyer.toLowerCase() === account.toLowerCase()) myBuy.push(o);
    if (account && o.seller.toLowerCase() === account.toLowerCase()) mySell.push(o);
  }

  const buyBox = $("#ordersBuyList");
  const sellBox = $("#ordersSellList");
  const statLabel = s => ({1:"PLACED", 2:"RELEASED", 3:"REFUNDED"}[s] || "NONE");

  const fmtRow = (o) => {
    const p = state.products.find(x => Number(x.productId) === Number(o.productId));
    const name = p ? p.name : `#${o.productId}`;
    const vinHuman = ethers.utils.formatUnits(o.vinAmount, 18);
    const canConfirm = (o.status === 1) && (account && o.buyer.toLowerCase() === account.toLowerCase());
    const canRefund  = (o.status === 1) && (Date.now()/1000 > o.deadline) && (account && o.buyer.toLowerCase() === account.toLowerCase());

    return `
    <div class="order-card" data-oid="${o.orderId}">
      <div class="order-row"><span class="order-strong">${name}</span> • Mã đơn #${o.orderId}</div>
      <div class="order-row">Số lượng: <span class="order-strong">${o.quantity}</span> • VIN: <span class="order-strong">${vinHuman}</span> • Trạng thái: ${statLabel(o.status)}</div>
      <div class="order-row">Hạn giao: ${new Date(o.deadline*1000).toLocaleString("vi-VN")}</div>
      <div class="card-actions">
        ${canConfirm ? `<button class="btn primary" data-act="confirm" data-id="${o.orderId}">Xác nhận nhận hàng</button>` : ""}
        ${canRefund ? `<button class="btn" data-act="refund" data-id="${o.orderId}">Hoàn tiền (quá hạn)</button>` : ""}
      </div>
    </div>`;
  };

  buyBox.innerHTML  = myBuy.length  ? myBuy.map(fmtRow).join("")  : `<div class="tag">Chưa có đơn mua.</div>`;
  sellBox.innerHTML = mySell.length ? mySell.map(fmtRow).join("") : `<div class="tag">Chưa có đơn bán.</div>`;

  // gán sự kiện
  $$("#ordersBuyList [data-act], #ordersSellList [data-act]").forEach(btn => {
    const act = btn.getAttribute("data-act");
    const oid = Number(btn.getAttribute("data-id"));
    if (act === "confirm") {
      btn.addEventListener("click", () => confirmReceipt(oid));
    } else if (act === "refund") {
      btn.addEventListener("click", () => refundIfExpired(oid));
    }
  });
}

async function loadOrdersAll(forceReload = false) {
  if (!muaban || !account) return;
  if (!forceReload && state.orders.length) {
    renderOrders();
    return;
  }
  const list = await scanAllOrders();
  state.orders = list;
  renderOrders();
}

async function confirmReceipt(orderId) {
  try {
    let gas;
    try {
      gas = await muaban.estimateGas.confirmReceipt(orderId);
    } catch { gas = ethers.BigNumber.from(300000); }
    const tx = await muaban.confirmReceipt(orderId, { gasLimit: gas.mul(13).div(10) });
    await tx.wait();
    toast("Đã xác nhận nhận hàng. VIN đã giải ngân cho người bán.");
    await loadOrdersAll(true);
  } catch (e) {
    console.error("confirmReceipt error:", e);
    toast(`Lỗi xác nhận: ${e?.data?.message || e?.error?.message || e?.message || "Internal JSON-RPC error."}`, "error");
  }
}

async function refundIfExpired(orderId) {
  try {
    let gas;
    try {
      gas = await muaban.estimateGas.refundIfExpired(orderId);
    } catch { gas = ethers.BigNumber.from(300000); }
    const tx = await muaban.refundIfExpired(orderId, { gasLimit: gas.mul(13).div(10) });
    await tx.wait();
    toast("Đã hoàn tiền cho bạn.");
    await loadOrdersAll(true);
  } catch (e) {
    console.error("refundIfExpired error:", e);
    toast(`Lỗi hoàn tiền: ${e?.data?.message || e?.error?.message || e?.message || "Internal JSON-RPC error."}`, "error");
  }
}

/* -------------------- 13) Tìm kiếm sản phẩm (client-side) -------------------- */
function doSearch() {
  const q = ($("#searchInput").value || "").trim().toLowerCase();
  if (!q) { renderProducts(state.products); return; }
  const filtered = state.products.filter(p => (p.name || "").toLowerCase().includes(q));
  renderProducts(filtered);
}

/* -------------------- 14) Gán sự kiện UI -------------------- */
function bindUI() {
  $("#btnConnect")?.addEventListener("click", connectWallet);
  $("#btnDisconnect")?.addEventListener("click", disconnectWalletUI);

  $("#btnRegister")?.addEventListener("click", registerWallet);

  $("#btnCreate")?.addEventListener("click", () => openModal("#formCreate"));
  $("#btnSubmitCreate")?.addEventListener("click", submitCreate);

  $("#btnSearch")?.addEventListener("click", doSearch);
  $("#searchInput")?.addEventListener("keydown", (e) => { if (e.key === "Enter") doSearch(); });

  // Close buttons trong các modal
  $$("#formCreate .close, #formUpdate .close, #formBuy .close").forEach(b => {
    b.addEventListener("click", closeModals);
  });

  // Update product submit
  $("#btnSubmitUpdate")?.addEventListener("click", submitUpdate);

  // Buy form
  $("#buyQty")?.addEventListener("input", updateBuyTotalVIN);
  $("#btnSubmitBuy")?.addEventListener("click", submitBuy);

  // Toggle hiển thị sections đơn hàng
  $("#btnOrdersBuy")?.addEventListener("click", async () => {
    $("#ordersSellSection").classList.add("hidden");
    $("#ordersBuySection").classList.remove("hidden");
    await loadOrdersAll();
  });
  $("#btnOrdersSell")?.addEventListener("click", async () => {
    $("#ordersBuySection").classList.add("hidden");
    $("#ordersSellSection").classList.remove("hidden");
    await loadOrdersAll();
  });

  // Khi mạng/tài khoản đổi
  if (window.ethereum) {
    window.ethereum.on?.("accountsChanged", () => {
      // reset & yêu cầu kết nối lại cho chắc chắn
      disconnectWalletUI();
      toast("Tài khoản MetaMask đã thay đổi. Vui lòng kết nối lại.");
    });
    window.ethereum.on?.("chainChanged", async (cidHex) => {
      if (cidHex !== VIC_CHAIN_ID_HEX) {
        toast("Bạn vừa chuyển sang mạng khác. Vui lòng về lại Viction.", "warn");
      }
      // reload để sync provider signer
      location.reload();
    });
  }
}

/* -------------------- 15) Khởi động -------------------- */
(async function init() {
  bindUI();

  // giá VIN
  await fetchVinPriceVND();
  // cập nhật giá định kỳ 60s
  setInterval(fetchVinPriceVND, 60_000);

  // Nếu đã có account trước đó (trình duyệt nhớ) → không auto connect; chờ người dùng bấm
  // Nhưng vẫn có thể hiển thị danh sách sản phẩm public (nếu bạn muốn miễn kết nối)
  // Ở đây cần contract readonly => tạo provider readonly nếu chưa có
  try {
    if (!provider) {
      const rpcProvider = new ethers.providers.JsonRpcProvider(VIC_RPC);
      const { muabanAbi } = await loadABIs();
      muaban = new ethers.Contract(MUABAN_ADDR, muabanAbi, rpcProvider);
    }
    await loadProducts(true);
  } catch (e) {
    console.warn("init loadProducts error:", e);
  }
})();
