<script>
/* ====================================================================
   muaban.vin — app.js (ethers v5)
   Mục tiêu:
   - Khắc phục “Internal JSON-RPC error.” bằng cách:
     + Ép legacy tx (type:0) + gasPrice (VIC không dùng EIP-1559)
     + Preflight (populateTransaction + provider.call({from})) để bắt reason
   - Khớp đúng ID theo index.html; hiển thị giá VIN/VND ổn định
==================================================================== */

/* -------------------- DOM helpers -------------------- */
const $  = (q)=>document.querySelector(q);
const $$ = (q)=>document.querySelectorAll(q);
const show = el=>{ if(!el) return; el.classList.remove('hidden'); };
const hide = el=>{ if(!el) return; el.classList.add('hidden'); };
const short=(a)=>a?`${a.slice(0,6)}…${a.slice(-4)}`: "";
const toast=(m)=>alert(m);

/* -------------------- Cấu hình -------------------- */
const DEFAULTS = {
  CHAIN_ID: 88,
  RPC_URL: "https://rpc.viction.xyz",
  EXPLORER: "https://vicscan.xyz",
  // Có thể override qua <body data-muaban-addr="..." data-vin-addr="...">
  MUABAN_ADDR: "0x190FD18820498872354eED9C4C080cB365Cd12E0",
  VIN_ADDR:    "0x941F63807401efCE8afe3C9d88d368bAA287Fac4",

  // Phí đăng ký 0.001 VIN (18 decimals)
  REG_FEE_WEI: "1000000000000000",

  // Nguồn tỷ giá
  COINGECKO_VIC_VND: "https://api.coingecko.com/api/v3/simple/price?ids=viction&vs_currencies=vnd",
  COINGECKO_USD_VND: "https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=vnd",
  COINGECKO_VIC_USD: "https://api.coingecko.com/api/v3/simple/price?ids=viction&vs_currencies=usd",
  BINANCE_VICUSDT:   "https://api.binance.com/api/v3/ticker/price?symbol=VICUSDT",
};

/* ---- GAS/FEES: ép legacy (gasPrice), không dùng EIP-1559 ---- */
const GAS_LIMIT_LIGHT = ethers.BigNumber.from("200000");   // approve/confirm/refund
const GAS_LIMIT_MED   = ethers.BigNumber.from("400000");   // payRegistration/update/placeOrder
const GAS_LIMIT_HEAVY = ethers.BigNumber.from("800000");   // createProduct
const LEGACY_GAS_PRICE_GWEI = "50";

/* -------------------- State -------------------- */
let providerRead, providerWrite, signer, account;
let MUABAN_ABI, VIN_ABI;
let muabanR, vinR; // read
let muaban,  vin;  // write

let isRegistered = false;
let vinPerVNDWei = ethers.BigNumber.from(0); // VIN wei / 1 VND (ceil)
let vinVND = 0;                               // 1 VIN = ? VND (floor)
let productsCache = [];
let ordersBuyer = [];
let ordersSeller = [];

/* -------------------- Utils -------------------- */
function parseRevert(err){
  const raw = err?.error?.message || err?.data?.message || err?.reason || err?.message || "";
  const map = {
    NOT_REGISTERED: "Ví chưa đăng ký. Hãy bấm ‘Đăng ký’ trước.",
    ALREADY_REGISTERED: "Ví đã đăng ký rồi.",
    PRICE_REQUIRED: "Giá bán (VND) phải > 0.",
    DELIVERY_REQUIRED: "Thời gian giao hàng (ngày) phải ≥ 1.",
    PAYOUT_WALLET_ZERO: "Ví nhận thanh toán không được để trống.",
    NOT_SELLER: "Bạn không phải người bán của sản phẩm này.",
    PRODUCT_NOT_ACTIVE: "Sản phẩm đang tắt bán.",
    PRODUCT_NOT_FOUND: "Không tìm thấy sản phẩm.",
    QUANTITY_REQUIRED: "Số lượng phải ≥ 1.",
    VIN_PER_VND_REQUIRED: "Tỷ giá chưa sẵn sàng. Vui lòng thử lại.",
    VIN_TRANSFER_FAIL: "Chuyển VIN thất bại (kiểm tra số dư/allowance).",
    NOT_PLACED: "Trạng thái đơn không hợp lệ.",
    NOT_BUYER: "Chỉ người mua mới thực hiện được thao tác này.",
    NOT_EXPIRED: "Đơn chưa quá hạn giao hàng."
  };
  for (const k in map) if (raw.includes(k)) return map[k];
  const m = /execution reverted(?: with reason string)?:\s*([^\n]+)/i.exec(raw);
  if (m) return m[1];
  try{
    const data = err?.error?.data || err?.data;
    if (typeof data === "string" && data.startsWith("0x") && data.length >= 10){
      const iface = new ethers.utils.Interface(["function Error(string)"]);
      const reason = iface.parseError(data)?.args?.[0];
      if (reason) return String(reason);
    }
  }catch(_){}
  return raw || "Giao dịch bị từ chối hoặc dữ liệu không hợp lệ.";
}
function showRpc(err, tag="RPC"){
  try{
    const obj = {
      tag, code: err?.code,
      message: err?.message || err?.error?.message,
      data: err?.data || err?.error?.data,
      reason: err?.reason,
    };
    console.error(tag, obj);
    alert(`${tag}\n${JSON.stringify(obj, null, 2)}`);
  }catch(_){
    console.error(tag, err);
    alert(`${tag}: ${String(err)}`);
  }
}
function parseVND(input){
  const digits = String(input||"").trim().replace(/[^\d]/g, "");
  if (!digits) return NaN;
  const n = Number(digits);
  return Number.isFinite(n) ? n : NaN;
}
function ipfsToHttp(link){
  if (!link) return "";
  if (link.startsWith("ipfs://")) return "https://ipfs.io/ipfs/" + link.replace("ipfs://", "");
  return link;
}
function parseUnitFromCID(desc){
  if (!desc) return "";
  const m = /^unit:(.+)$/i.exec(desc.trim());
  return m ? m[1].trim() : "";
}
function escapeHtml(str){
  return String(str).replace(/[&<>"']/g, s=>({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;" }[s] || s));
}
function statusText(code){
  const m = {0:"-",1:"Đang xử lý",2:"Đã giải ngân",3:"Đã hoàn tiền"};
  return m[Number(code)] || "-";
}

/* -------------------- ABI + Address -------------------- */
async function loadAbis(){
  MUABAN_ABI = await fetch("Muaban_ABI.json").then(r=>r.json());
  VIN_ABI    = await fetch("VinToken_ABI.json").then(r=>r.json());
}
function readAddrs(){
  const b = document.body;
  const ma = b?.dataset?.muabanAddr;
  const va = b?.dataset?.vinAddr;
  return {
    MUABAN_ADDR: (ma && ethers.utils.isAddress(ma) ? ma : DEFAULTS.MUABAN_ADDR),
    VIN_ADDR:    (va && ethers.utils.isAddress(va) ? va : DEFAULTS.VIN_ADDR)
  };
}

/* -------------------- Providers & Contracts -------------------- */
function initProviders(){
  providerRead  = new ethers.providers.JsonRpcProvider(DEFAULTS.RPC_URL);
  if (window.ethereum) providerWrite = new ethers.providers.Web3Provider(window.ethereum, "any");
}
function initContractsForRead(){
  const { MUABAN_ADDR, VIN_ADDR } = readAddrs();
  muabanR = new ethers.Contract(MUABAN_ADDR, MUABAN_ABI, providerRead);
  vinR    = new ethers.Contract(VIN_ADDR,    VIN_ABI,    providerRead);
}
function initContractsForWrite(){
  const { MUABAN_ADDR, VIN_ADDR } = readAddrs();
  muaban = new ethers.Contract(MUABAN_ADDR, MUABAN_ABI, signer);
  vin    = new ethers.Contract(VIN_ADDR,    VIN_ABI,    signer);
}

/* -------------------- Tỷ giá VIN/VND -------------------- */
function bodyVinVndOverride(){
  const raw = document.body?.dataset?.vinVnd;
  const n = Number(raw);
  return Number.isFinite(n) && n>0 ? Math.floor(n) : 0;
}
async function fetchVinToVND(){
  try{
    const override = bodyVinVndOverride();
    if (override>0){
      vinVND = override;
    }else{
      // 1) VIC→VND (Coingecko)
      let vicVnd = 0;
      try{
        const r = await fetch(DEFAULTS.COINGECKO_VIC_VND);
        const j = await r.json();
        vicVnd = Number(j?.viction?.vnd||0);
      }catch(_){}

      if (vicVnd>0){
        vinVND = Math.floor(vicVnd * 100);
      }else{
        // 2) VIC→USD × USDT→VND
        const [vicUsdRes, usdtVndRes] = await Promise.all([
          fetch(DEFAULTS.COINGECKO_VIC_USD),
          fetch(DEFAULTS.COINGECKO_USD_VND)
        ]);
        const vicUsd = Number((await vicUsdRes.json())?.viction?.usd||0);
        const usdtVnd= Number((await usdtVndRes.json())?.tether?.vnd||0);
        if (vicUsd>0 && usdtVnd>0){
          vinVND = Math.floor(vicUsd * 100 * usdtVnd);
        }else{
          // 3) Binance VIC/USDT × USDT→VND
          const [vicPriceRes2, usdtVndRes2] = await Promise.all([
            fetch(DEFAULTS.BINANCE_VICUSDT),
            fetch(DEFAULTS.COINGECKO_USD_VND)
          ]);
          const vicUsdt = Number((await vicPriceRes2.json())?.price||0);
          const usdtVnd2= Number((await usdtVndRes2.json())?.tether?.vnd||0);
          if (vicUsdt>0 && usdtVnd2>0) vinVND = Math.floor(vicUsdt * 100 * usdtVnd2);
        }
      }
    }

    if (!(vinVND>0)) throw new Error("Không lấy được giá");

    const ONE = ethers.BigNumber.from("1000000000000000000");
    vinPerVNDWei = ONE.div(vinVND);
    if (ONE.mod(vinVND).gt(0)) vinPerVNDWei = vinPerVNDWei.add(1); // ceil

    $("#vinPrice")?.replaceChildren(`1 VIN = ${vinVND.toLocaleString("vi-VN")} VND`);
  }catch(e){
    console.error("fetchVinToVND:", e);
    if (vinPerVNDWei.isZero()) $("#vinPrice")?.replaceChildren("Đang tải giá…");
  }
}

/* -------------------- Kết nối / Ngắt kết nối -------------------- */
async function connectWallet(){
  try{
    if (!window.ethereum){ toast("Vui lòng cài MetaMask."); return; }
    await providerWrite.send("eth_requestAccounts", []);
    const net = await providerWrite.getNetwork();
    if (Number(net.chainId)!==DEFAULTS.CHAIN_ID){ toast("Sai mạng. Chọn Viction (chainId=88)."); return; }
    signer = providerWrite.getSigner();
    account = (await signer.getAddress()).toLowerCase();

    initContractsForWrite();

    hide($("#btnConnect")); show($("#walletBox"));
    $("#accountShort").textContent = short(account);
    $("#accountShort").href = `${DEFAULTS.EXPLORER}/address/${account}`;

    const [vinBal, vicBal] = await Promise.all([vinR.balanceOf(account), providerWrite.getBalance(account)]);
    $("#vinBalance").textContent = `VIN: ${parseFloat(ethers.utils.formatUnits(vinBal,18)).toFixed(4)}`;
    $("#vicBalance").textContent = `VIC: ${parseFloat(ethers.utils.formatEther(vicBal)).toFixed(4)}`;

    isRegistered = await muabanR.registered(account);
    refreshMenu();

    await Promise.all([loadAllProducts(), loadMyOrders()]);
  }catch(e){
    showRpc(e, "connectWallet");
  }
}
function disconnectWallet(){
  account = null; signer = null; muaban=null; vin=null;
  hide($("#walletBox")); show($("#btnConnect"));
  $("#vinBalance").textContent = "VIN: 0";
  $("#vicBalance").textContent = "VIC: 0";
  isRegistered = false;
  refreshMenu();
}
function refreshMenu(){
  const btnReg = $("#btnRegister");
  const btnCrt = $("#btnCreate");
  const btnOB  = $("#btnOrdersBuy");
  const btnOS  = $("#btnOrdersSell");
  const menu   = $("#menuBox");
  if (!account){
    btnReg?.classList.remove('hidden'); if (btnReg) btnReg.disabled = true;
    btnCrt?.classList.add('hidden'); btnOB?.classList.add('hidden'); btnOS?.classList.add('hidden');
    return;
  }
  if (!isRegistered){
    btnReg?.classList.remove('hidden'); if (btnReg) btnReg.disabled = false;
    btnCrt?.classList.add('hidden'); btnOB?.classList.add('hidden'); btnOS?.classList.add('hidden');
  }else{
    btnReg?.classList.add('hidden');
    btnCrt?.classList.remove('hidden'); btnOB?.classList.remove('hidden'); btnOS?.classList.remove('hidden');
  }
  menu?.classList.remove('hidden');
}

/* -------------------- Sản phẩm -------------------- */
async function loadAllProducts(){
  try{
    const { MUABAN_ADDR } = readAddrs();
    const iface = new ethers.utils.Interface(MUABAN_ABI);
    const topic = iface.getEventTopic("ProductCreated");
    const logs = await providerRead.getLogs({ address: MUABAN_ADDR, fromBlock: 0, toBlock: "latest", topics: [topic] });
    const pids = new Set();
    logs.forEach(l=>{ const parsed = iface.parseLog(l); pids.add(parsed.args.productId.toString()); });

    productsCache = [];
    for (const pid of Array.from(pids).sort((a,b)=>Number(a)-Number(b))){
      const p = await muabanR.getProduct(pid);
      productsCache.push({ pid: Number(pid), data: p });
    }
    renderProducts(productsCache);
  }catch(e){ console.error("loadAllProducts:", e); }
}
function renderProducts(list){
  const wrap = $("#productList");
  if (!wrap) return;
  wrap.innerHTML = "";
  if (!list.length){ wrap.innerHTML = `<div class="tag">Chưa có sản phẩm.</div>`; return; }
  list.forEach(({pid, data})=>{
    const unit = parseUnitFromCID(data.descriptionCID);
    const img = ipfsToHttp(data.imageCID);
    const active = data.active;
    const price = Number(data.priceVND);
    const card = document.createElement("div");
    card.className = "product-card";
    card.innerHTML = `
      <img class="product-thumb" src="${img}" onerror="this.src='https://via.placeholder.com/112x90?text=IPFS'"/>
      <div class="product-info">
        <div class="product-top">
          <h3 class="product-title">${escapeHtml(data.name)}</h3>
          <span class="badge mono">#${pid}</span>
        </div>
        <div class="product-meta">
          <span class="price-vnd">${price.toLocaleString('vi-VN')} VND</span> <span class="unit">/ ${escapeHtml(unit||"đv")}</span>
        </div>
        <div>
          <span class="stock-badge ${active? "":"out"}">${active? "Còn hàng":"Hết hàng"}</span>
          <span class="tag mono" title="${data.payoutWallet}">Người bán: ${short(data.seller)}</span>
          <span class="tag">Giao tối đa ${data.deliveryDaysMax} ngày</span>
        </div>
        <div class="card-actions">
          ${(!account) ? "" :
            (data.seller?.toLowerCase()===account?.toLowerCase()
              ? `<button class="btn" data-action="update" data-pid="${pid}">Cập nhật sản phẩm</button>`
              : (isRegistered && active ? `<button class="btn primary" data-action="buy" data-pid="${pid}">Mua</button>` : "")
            )
          }
        </div>
      </div>`;
    card.querySelector('[data-action="buy"]')?.addEventListener("click", ()=> openBuyForm(pid, data));
    card.querySelector('[data-action="update"]')?.addEventListener("click", ()=> openUpdateForm(pid, data));
    wrap.appendChild(card);
  });
}

/* -------------------- Search -------------------- */
$("#btnSearch")?.addEventListener("click", ()=>{
  const q = ($("#searchInput")?.value||"").trim().toLowerCase();
  if (!q) { renderProducts(productsCache); return; }
  const list = productsCache.filter(({data})=> data.name.toLowerCase().includes(q));
  renderProducts(list);
});

/* -------------------- Legacy GAS overrides -------------------- */
async function buildOverrides(kind="med"){
  const ov = { type: 0, gasPrice: ethers.utils.parseUnits(LEGACY_GAS_PRICE_GWEI, "gwei") };
  if (kind==="light") ov.gasLimit = GAS_LIMIT_LIGHT;
  else if (kind==="heavy") ov.gasLimit = GAS_LIMIT_HEAVY;
  else ov.gasLimit = GAS_LIMIT_MED;
  return ov;
}

/* -------------------- Đăng ký -------------------- */
$("#btnRegister")?.addEventListener("click", async ()=>{
  if (!account){ toast("Hãy kết nối ví."); return; }
  try{
    const need = ethers.BigNumber.from(DEFAULTS.REG_FEE_WEI);
    const { MUABAN_ADDR } = readAddrs();

    // ensure allowance
    const allow = await vinR.allowance(account, MUABAN_ADDR);
    if (allow.lt(need)){
      try{
        const ovA = await buildOverrides("light");
        const txA = await vin.approve(MUABAN_ADDR, need, ovA);
        await txA.wait();
      }catch(e){ showRpc(e, "approve.payRegistration"); return; }
    }

    // simulate
    try{
      const txData = await muaban.populateTransaction.payRegistration();
      txData.from = account;
      await providerWrite.call(txData);
    }catch(simErr){ toast(parseRevert(simErr)); return; }

    // send
    try{
      const ov = await buildOverrides("med");
      const tx = await muaban.payRegistration(ov);
      await tx.wait();
    }catch(e){ showRpc(e, "send.payRegistration"); return; }

    isRegistered = true;
    toast("Đăng ký thành công.");
    refreshMenu();
  }catch(e){ showRpc(e, "btnRegister.catch"); }
});

/* -------------------- Tạo sản phẩm -------------------- */
$("#btnCreate")?.addEventListener("click", ()=>{
  if (!isRegistered){ toast("Ví chưa đăng ký. Bấm ‘Đăng ký’ trước."); return; }
  $("#createName")?.value=""; $("#createIPFS")?.value="";
  $("#createUnit")?.value=""; $("#createPrice")?.value="";
  $("#createWallet")?.value=account||""; $("#createDays")?.value="3";
  show($("#formCreate"));
});
$(".modal#formCreate .close")?.addEventListener("click", ()=> hide($("#formCreate")));

$("#btnSubmitCreate")?.addEventListener("click", async ()=>{
  if (!account){ toast("Hãy kết nối ví."); return; }
  if (!isRegistered){ toast("Ví chưa đăng ký."); return; }
  try{
    const name = ($("#createName")?.value||"").trim();
    const ipfs = ($("#createIPFS")?.value||"").trim();
    const unit = ($("#createUnit")?.value||"").trim();
    const priceVNDNum = parseVND($("#createPrice")?.value);
    const wallet = ($("#createWallet")?.value||"").trim();
    const days = Number($("#createDays")?.value||0);

    if (!name || !ipfs || !unit || !priceVNDNum || !wallet || !days){ toast("Vui lòng nhập đủ thông tin."); return; }
    const descriptionCID = `unit:${unit}`;
    const imageCID = ipfs;
    const priceVND = ethers.BigNumber.from(String(priceVNDNum));

    // simulate
    try{
      const txData = await muaban.populateTransaction.createProduct(
        name, descriptionCID, imageCID, priceVND, days, wallet, true
      );
      txData.from = account;
      await providerWrite.call(txData);
    }catch(simErr){ toast(parseRevert(simErr)); return; }

    // send
    try{
      const ov = await buildOverrides("heavy");
      const tx = await muaban.createProduct(
        name, descriptionCID, imageCID, priceVND, days, wallet, true, ov
      );
      await tx.wait();
    }catch(e){ showRpc(e, "send.createProduct"); return; }

    hide($("#formCreate"));
    toast("Đăng sản phẩm thành công.");
    await loadAllProducts();
  }catch(e){ showRpc(e, "btnSubmitCreate.catch"); }
});

/* -------------------- Cập nhật sản phẩm -------------------- */
function openUpdateForm(pid, p){
  $("#updatePid").value = String(pid);
  $("#updatePrice").value = String(p.priceVND||"");
  $("#updateDays").value  = String(p.deliveryDaysMax||"");
  $("#updateWallet").value= String(p.payoutWallet||"");
  $("#updateActive").checked = !!p.active;
  show($("#formUpdate"));
}
$(".modal#formUpdate .close")?.addEventListener("click", ()=> hide($("#formUpdate")));
$("#btnSubmitUpdate")?.addEventListener("click", async ()=>{
  if (!account){ toast("Hãy kết nối ví."); return; }
  try{
    const pid   = Number($("#updatePid").value||0);
    const price = parseVND($("#updatePrice").value);
    const days  = Number($("#updateDays").value||0);
    const wallet= ($("#updateWallet").value||"").trim();
    const active= !!$("#updateActive").checked;

    if (!pid || !price || !days || !wallet){ toast("Vui lòng nhập đủ thông tin."); return; }

    // simulate
    try{
      const txData = await muaban.populateTransaction.updateProduct(
        pid, ethers.BigNumber.from(String(price)), days, wallet, active
      );
      txData.from = account;
      await providerWrite.call(txData);
    }catch(simErr){ toast(parseRevert(simErr)); return; }

    // send
    try{
      const ov = await buildOverrides("med");
      const tx = await muaban.updateProduct(
        pid, ethers.BigNumber.from(String(price)), days, wallet, active, ov
      );
      await tx.wait();
    }catch(e){ showRpc(e, "send.updateProduct"); return; }

    hide($("#formUpdate"));
    toast("Cập nhật thành công.");
    await loadAllProducts();
  }catch(e){ showRpc(e, "btnSubmitUpdate.catch"); }
});

/* -------------------- Mua hàng -------------------- */
function openBuyForm(pid, p){
  const modal = $("#formBuy");
  if (!modal){ toast("Thiếu form mua hàng trong HTML."); return; }
  modal.dataset.pid = String(pid);
  $("#buyQty").value = "1";
  $("#buyName").value = "";
  $("#buyAddress").value = "";
  $("#buyPhone").value= "";
  $("#buyNote").value = "";
  updateTotalVinInBuyForm(p.priceVND||0, 1);
  modal.classList.remove("hidden");
}
$(".modal#formBuy .close")?.addEventListener("click", ()=> hide($("#formBuy")));
$("#buyQty")?.addEventListener("input", ()=>{
  const pid = Number($("#formBuy")?.dataset?.pid||0);
  const p = productsCache.find(x=>x.pid===pid)?.data;
  if (p) updateTotalVinInBuyForm(p.priceVND||0, Number($("#buyQty").value||1));
});
function updateTotalVinInBuyForm(priceVND, qty){
  const totalVND = (Number(priceVND)||0) * (Number(qty)||0);
  if (vinPerVNDWei.isZero()){ $("#buyTotalVIN").textContent = "VIN: …"; return; }
  const totalVinWei = ethers.BigNumber.from(String(totalVND)).mul(vinPerVNDWei);
  $("#buyTotalVIN").textContent = `~ ${parseFloat(ethers.utils.formatUnits(totalVinWei,18)).toFixed(6)} VIN`;
}
$("#btnSubmitBuy")?.addEventListener("click", async ()=>{
  if (!account){ toast("Hãy kết nối ví."); return; }
  if (vinPerVNDWei.isZero()){ toast("Chưa có tỷ giá VIN/VND. Vui lòng đợi giá."); return; }
  try{
    const pid = Number($("#formBuy")?.dataset?.pid||0);
    const p = productsCache.find(x=>x.pid===pid)?.data;
    if (!p){ toast("Không tìm thấy sản phẩm."); return; }

    const qty   = Math.max(1, Number($("#buyQty").value||1));
    const name  = ($("#buyName").value||"").trim();
    const addr  = ($("#buyAddress").value||"").trim();
    const phone = ($("#buyPhone").value||"").trim();
    const note  = ($("#buyNote").value||"").trim();

    if (!name || !addr || !phone){ toast("Vui lòng nhập đầy đủ Họ tên / Địa chỉ / SĐT."); return; }

    // Mã hoá tối giản (demo)
    const buyerInfoCipher = btoa(JSON.stringify({name,addr,phone,note}));

    // Tính VIN cần escrow
    const totalVND = ethers.BigNumber.from(String(Number(p.priceVND))).mul(qty);
    const totalVinWei = totalVND.mul(vinPerVNDWei);

    // ensure allowance
    const { MUABAN_ADDR } = readAddrs();
    const allow = await vinR.allowance(account, MUABAN_ADDR);
    if (allow.lt(totalVinWei)){
      try{
        const ovA = await buildOverrides("light");
        const txA = await vin.approve(MUABAN_ADDR, totalVinWei, ovA);
        await txA.wait();
      }catch(e){ showRpc(e, "approve.placeOrder"); return; }
    }

    // simulate: placeOrder(productId, quantity, vinPerVND, buyerInfoCipher)
    try{
      const txData = await muaban.populateTransaction.placeOrder(
        pid, qty, vinPerVNDWei.toString(), buyerInfoCipher
      );
      txData.from = account;
      await providerWrite.call(txData);
    }catch(simErr){ toast(parseRevert(simErr)); return; }

    // send
    try{
      const ov = await buildOverrides("med");
      const tx = await muaban.placeOrder(pid, qty, vinPerVNDWei.toString(), buyerInfoCipher, ov);
      await tx.wait();
    }catch(e){ showRpc(e, "send.placeOrder"); return; }

    hide($("#formBuy"));
    toast("Đặt hàng thành công.");
    await loadMyOrders();
  }catch(e){ showRpc(e, "btnSubmitBuy.catch"); }
});

/* -------------------- Đơn hàng của tôi -------------------- */
async function loadMyOrders(){
  try{
    if (!account){ return; }
    const { MUABAN_ADDR } = readAddrs();
    const iface = new ethers.utils.Interface(MUABAN_ABI);
    const topic = iface.getEventTopic("OrderPlaced");
    const logs = await providerRead.getLogs({ address: MUABAN_ADDR, fromBlock: 0, toBlock: "latest", topics: [topic] });

    const buyerOids = [], sellerOids = [];
    logs.forEach(l=>{
      const ev = iface.parseLog(l);
      const oid = Number(ev.args.orderId);
      const pid = Number(ev.args.productId);
      const buyer = String(ev.args.buyer).toLowerCase();
      if (buyer===account) buyerOids.push(oid);
      sellerOids.push({oid, pid});
    });

    ordersBuyer = [];
    ordersSeller = [];
    for (const oid of buyerOids){
      const o = await muabanR.getOrder(oid);
      ordersBuyer.push(o);
    }
    for (const it of sellerOids){
      const p = await muabanR.getProduct(it.pid);
      if (p?.seller?.toLowerCase()===account){
        const o = await muabanR.getOrder(it.oid);
        ordersSeller.push(o);
      }
    }
    renderOrders();
  }catch(e){ console.error("loadMyOrders:", e); }
}
function renderOrders(){
  // Buyer
  const listB = $("#ordersBuyList");
  if (listB){
    listB.innerHTML = "";
    if (!ordersBuyer.length){ listB.innerHTML = `<div class="tag">Chưa có đơn mua.</div>`; }
    ordersBuyer.forEach(o=>{
      const div = document.createElement("div");
      div.className = "order-card";
      div.innerHTML = `
        <div class="order-row"><span class="order-strong">#${o.orderId}</span> <span>${statusText(o.status)}</span></div>
        <div class="order-row">Sản phẩm: #${o.productId} — SL: ${o.quantity}</div>
        <div class="order-row">VIN escrow: ${ethers.utils.formatUnits(o.vinAmount,18)}</div>
        <div class="card-actions">
          ${Number(o.status)===1 ? `<button class="btn" data-b="rcv" data-oid="${o.orderId}">Xác nhận đã nhận hàng</button>
                                     <button class="btn" data-b="rf"  data-oid="${o.orderId}">Hoàn tiền</button>` : ``}
        </div>`;
      div.querySelector('[data-b="rcv"]')?.addEventListener("click", ()=> confirmReceipt(o.orderId));
      div.querySelector('[data-b="rf"]') ?.addEventListener("click", ()=> refundOrder(o.orderId));
      listB.appendChild(div);
    });
  }
  // Seller
  const listS = $("#ordersSellList");
  if (listS){
    listS.innerHTML = "";
    if (!ordersSeller.length){ listS.innerHTML = `<div class="tag">Chưa có đơn bán.</div>`; }
    ordersSeller.forEach(o=>{
      const div = document.createElement("div");
      div.className = "order-card";
      div.innerHTML = `
        <div class="order-row"><span class="order-strong">#${o.orderId}</span> <span>${statusText(o.status)}</span></div>
        <div class="order-row">Sản phẩm: #${o.productId} — SL: ${o.quantity}</div>
        <div class="order-row">VIN escrow: ${ethers.utils.formatUnits(o.vinAmount,18)}</div>`;
      listS.appendChild(div);
    });
  }
}
async function confirmReceipt(oid){
  try{
    // simulate
    try{
      const txData = await muaban.populateTransaction.confirmReceipt(oid);
      txData.from = account;
      await providerWrite.call(txData);
    }catch(simErr){ toast(parseRevert(simErr)); return; }

    // send
    try{
      const ov = await buildOverrides("light");
      const tx = await muaban.confirmReceipt(oid, ov);
      await tx.wait();
    }catch(e){ showRpc(e, "send.confirmReceipt"); return; }

    toast("Đã xác nhận nhận hàng.");
    await loadMyOrders();
  }catch(e){ showRpc(e, "confirmReceipt.catch"); }
}
async function refundOrder(oid){
  try{
    // simulate
    try{
      const txData = await muaban.populateTransaction.refundOrder(oid);
      txData.from = account;
      await providerWrite.call(txData);
    }catch(simErr){ toast(parseRevert(simErr)); return; }

    // send
    try{
      const ov = await buildOverrides("light");
      const tx = await muaban.refundOrder(oid, ov);
      await tx.wait();
    }catch(e){ showRpc(e, "send.refundOrder"); return; }

    toast("Đã yêu cầu hoàn tiền.");
    await loadMyOrders();
  }catch(e){ showRpc(e, "refundOrder.catch"); }
}

/* -------------------- Điều hướng menu -------------------- */
$("#btnOrdersBuy")?.addEventListener("click", ()=>{
  show($("#ordersBuySection")); hide($("#ordersSellSection"));
});
$("#btnOrdersSell")?.addEventListener("click", ()=>{
  show($("#ordersSellSection")); hide($("#ordersBuySection"));
});

/* -------------------- Boot -------------------- */
window.addEventListener("DOMContentLoaded", async ()=>{
  try{
    await loadAbis();
    initProviders();
    initContractsForRead();
    fetchVinToVND().catch(()=>{});
    $("#btnConnect")?.addEventListener("click", connectWallet);
    $("#btnDisconnect")?.addEventListener("click", disconnectWallet);
    await loadAllProducts();
  }catch(e){
    console.error("boot:", e);
  }
});
</script>
