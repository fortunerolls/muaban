/* =====================================================================================
   muaban.vin — app.js (ethers v5)  •  "one-time approve" flow như Dice
   - Single large approve VIN cho hợp đồng Muaban => giảm số lần ký tối đa
   - Đăng ký: chỉ call payRegistration() (không approve lại nếu allowance đủ)
   - Mua hàng: chỉ call placeOrder() (không approve lại nếu allowance đủ)
   - Có ensureChain + gas overrides (tham khảo Dice)  :contentReference[oaicite:3]{index=3}
   ===================================================================================== */

/* -------------------- Cấu hình -------------------- */
const CONFIG = {
  CHAIN_ID: 88,
  CHAIN_ID_HEX: "0x58",
  RPC_URL: "https://rpc.viction.xyz",
  EXPLORER: "https://scan.viction.xyz",
  MUABAN_ADDR: "0x190FD18820498872354eED9C4C080cB365Cd12E0",   // contract mới bạn vừa deploy
  VIN_ADDR: "0x941F63807401efCE8afe3C9d88d368bAA287Fac4"
};

/* One-time approve mặc định 10,000 VIN (bạn có thể đổi) */
const ONE_TIME_APPROVE_VIN = "10000";

/* Gas policy (tham khảo Dice) :contentReference[oaicite:4]{index=4} */
const GAS = {
  MIN_PRIORITY_GWEI: 3,
  MIN_MAXFEE_GWEI: 12,
  MIN_GASPRICE_GWEI: 8,
  LIMIT_APPROVE: 80000,
  LIMIT_SIMPLE: 200000,
  LIMIT_ORDER: 500000
};

/* -------------------- Trạng thái -------------------- */
let providerRO, provider, signer, account;
let muaban, vin;
let MUABAN_ABI, VIN_ABI;

let usdtVND = null;   // 1 USDT = ? VND
let vicUSDT = null;   // 1 VIC  = ? USDT
let vinVND  = null;   // 1 VIN  = ? VND (floor)
let vinPerVNDWei = null; // VIN wei cho 1 VND

/* -------------------- Helpers -------------------- */
const $  = (q) => document.querySelector(q);
const $$ = (q) => document.querySelectorAll(q);
const show = (el) => el && el.removeAttribute("hidden");
const hide = (el) => el && el.setAttribute("hidden", "");
const fmtVND = (n) => Number(n || 0).toLocaleString("vi-VN");
const short = (a) => (a ? a.slice(0,6) + "…" + a.slice(-4) : "");
const esc = (s) => (s||"").replace(/[&<>"']/g,(c)=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));

/* =====================================================================================
   1) Boot: nạp ABI, init read-only, lấy tỷ giá, render sản phẩm
   ===================================================================================== */
(async function boot(){
  bindUI();
  await loadABIs();
  initReadOnly();
  await refreshRates();
  await renderProducts();
  refreshHeaderButtonsWhenDisconnected();
})();

/* =====================================================================================
   2) ABI + Providers
   ===================================================================================== */
async function loadABIs(){
  MUABAN_ABI = await fetch("./abi/Muaban_ABI.json").then(r=>r.json());
  VIN_ABI    = await fetch("./abi/VinToken_ABI.json").then(r=>r.json());
}
function initReadOnly(){
  providerRO = new ethers.providers.JsonRpcProvider(CONFIG.RPC_URL);
  muaban = new ethers.Contract(CONFIG.MUABAN_ADDR, MUABAN_ABI, providerRO);
  vin    = new ethers.Contract(CONFIG.VIN_ADDR,    VIN_ABI,    providerRO);
}

/* =====================================================================================
   3) Wallet Flow — ensureChain (như Dice) + connect + số dư + đăng ký
   ===================================================================================== */
async function ensureChain(){
  if(!window.ethereum) throw new Error("Hãy cài MetaMask / ví EVM.");
  const ch = await window.ethereum.request({ method: "eth_chainId" });
  if (ch !== CONFIG.CHAIN_ID_HEX){
    try{
      await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CONFIG.CHAIN_ID_HEX }] });
    }catch(e){
      if(e && e.code === 4902){
        await window.ethereum.request({
          method: "wallet_addEthereumChain",
          params: [{
            chainId: CONFIG.CHAIN_ID_HEX,
            chainName: "Viction",
            rpcUrls: [CONFIG.RPC_URL],
            blockExplorerUrls: [CONFIG.EXPLORER],
            nativeCurrency: { name: "VIC", symbol: "VIC", decimals: 18 }
          }]
        });
      }else{
        throw e;
      }
    }
  }
}

async function connectWallet(){
  await ensureChain(); // :contentReference[oaicite:5]{index=5}

  provider = new ethers.providers.Web3Provider(window.ethereum);
  await provider.send("eth_requestAccounts", []);
  signer  = provider.getSigner();
  account = await signer.getAddress();

  muaban = muaban.connect(signer);
  vin    = vin.connect(signer);

  $("#btn-connect").textContent = "Đã kết nối";
  $("#addr-short").textContent  = short(account);
  show($("#balances"));

  await refreshBalances();
  await refreshRegistration();
  await ensureApproveButton(); // chèn nút Approve 1 lần nếu cần

  // reload khi đổi account/chain
  if(!window._muaban_hooks){
    window._muaban_hooks = true;
    window.ethereum.on("accountsChanged",()=>location.reload());
    window.ethereum.on("chainChanged",()=>location.reload());
  }
}

function refreshHeaderButtonsWhenDisconnected(){
  if(!account){
    hide($("#balances"));
    hide($("#btn-register"));
    hide($("#btn-create"));
    hide($("#btn-buyer-orders"));
    hide($("#btn-seller-orders"));
  }
}

async function refreshBalances(){
  if(!account) return;
  const balVIN = await vin.balanceOf(account);
  const balVIC = await provider.getBalance(account);
  $("#bal-vin").textContent = Number(ethers.utils.formatUnits(balVIN, 18)).toFixed(4);
  $("#bal-vic").textContent = Number(ethers.utils.formatEther(balVIC)).toFixed(4);
}

async function refreshRegistration(){
  if(!account) return;
  const reg = await muaban.registered(account);
  if (reg){
    hide($("#btn-register"));
    show($("#btn-create"));
    show($("#btn-buyer-orders"));
    show($("#btn-seller-orders"));
  }else{
    show($("#btn-register"));
    hide($("#btn-create"));
    hide($("#btn-buyer-orders"));
    hide($("#btn-seller-orders"));
  }
}

/* =====================================================================================
   4) Gas overrides (mô phỏng Dice) — để ví ít hỏi + tx dễ vào block  :contentReference[oaicite:6]{index=6}
   ===================================================================================== */
async function buildOverrides(kind="simple"){
  const fee = await provider.getFeeData();
  const prioMin = ethers.utils.parseUnits(String(GAS.MIN_PRIORITY_GWEI), "gwei");
  const maxMin  = ethers.utils.parseUnits(String(GAS.MIN_MAXFEE_GWEI), "gwei");
  const gasPriceMin = ethers.utils.parseUnits(String(GAS.MIN_GASPRICE_GWEI), "gwei");
  const gasLimit = ethers.BigNumber.from(
    kind === "approve" ? GAS.LIMIT_APPROVE :
    kind === "order"   ? GAS.LIMIT_ORDER   : GAS.LIMIT_SIMPLE
  );

  if (fee.maxFeePerGas && fee.maxPriorityFeePerGas){
    let prio = fee.maxPriorityFeePerGas.gte(prioMin) ? fee.maxPriorityFeePerGas : prioMin;
    let maxf = fee.maxFeePerGas.mul(2).add(prio);
    if (maxf.lt(maxMin)) maxf = maxMin;
    return { gasLimit, maxFeePerGas: maxf, maxPriorityFeePerGas: prio };
  } else {
    let gp = fee.gasPrice && fee.gasPrice.gte(gasPriceMin) ? fee.gasPrice : gasPriceMin;
    return { gasLimit, gasPrice: gp };
  }
}

/* =====================================================================================
   5) One-time Approve — giống tư duy Dice: người dùng chủ động bấm “Approve VIN”
   ===================================================================================== */
async function ensureApproveButton(){
  // tạo nút nếu chưa có
  let btn = document.getElementById("btn-approve-once");
  if (!btn){
    btn = document.createElement("button");
    btn.id = "btn-approve-once";
    btn.className = "btn ghost";
    btn.textContent = "Phê duyệt VIN (một lần)";
    // ghim vào thanh công cụ cạnh nút Đăng ký (nếu tồn tại)
    const bar = document.querySelector(".search .row") || document.querySelector(".search") || document.querySelector(".section .row");
    const anchor = document.getElementById("btn-register") || document.getElementById("btn-create") || document.getElementById("btn-search");
    const parent = document.querySelector(".search") || document.querySelector(".section");
    (anchor?.parentElement || parent || document.body).insertBefore(btn, anchor?.nextSibling || null);
  }

  // ẩn/hiện theo allowance
  const ok = await hasSufficientAllowance();
  btn.hidden = ok; // đủ allowance -> ẩn nút
  btn.onclick = approveOnce;
}

async function hasSufficientAllowance(minWei){
  if(!account) return false;
  const alw = await vin.allowance(account, CONFIG.MUABAN_ADDR);
  if (!minWei) {
    // tối thiểu phải đủ cho REG_FEE
    const fee = await muaban.REG_FEE();
    minWei = fee;
  }
  return alw.gte(minWei);
}

async function approveOnce(){
  try{
    const amountWei = ethers.utils.parseUnits(ONE_TIME_APPROVE_VIN, 18);
    const overrides = await buildOverrides("approve");
    const tx = await vin.approve(CONFIG.MUABAN_ADDR, amountWei, overrides);
    await tx.wait();
    alert(`Đã phê duyệt ${ONE_TIME_APPROVE_VIN} VIN cho hợp đồng.`);
    await ensureApproveButton(); // ẩn nút
  }catch(e){
    console.error(e);
    alert("Approve thất bại: " + (e?.message || e));
  }
}

/* =====================================================================================
   6) Tỷ giá VIN/VND (giống trước, chuẩn hoá BigNumber)
   ===================================================================================== */
async function refreshRates(){
  try{
    const gk = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=vnd",{cache:"no-store"}).then(r=>r.json());
    usdtVND = Number(gk?.tether?.vnd || 0);

    const bi = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=VICUSDT",{cache:"no-store"}).then(r=>r.json());
    vicUSDT = Number(bi?.price || 0);

    if(!usdtVND || !vicUSDT) throw 0;

    vinVND = Math.floor(vicUSDT * 100 * usdtVND);
    $("#vin-vnd").textContent = `1 VIN = ${fmtVND(vinVND)} VND`;

    // VIN wei per 1 USD = (vicUSDT*100) * 1e18
    const vinPerUSDWei = ethers.utils.parseUnits((vicUSDT * 100).toString(), 18);
    // per VND = per USD / usdtVND
    vinPerVNDWei = vinPerUSDWei.div(ethers.BigNumber.from(Math.round(usdtVND).toString()));
  }catch{
    $("#vin-vnd").textContent = "1 VIN = … VND";
    vinPerVNDWei = null;
  }
}

/* =====================================================================================
   7) Sản phẩm: quét event ProductCreated -> getProduct -> render + tìm kiếm
   ===================================================================================== */
async function renderProducts(){
  const list = $("#list"), empty=$("#empty");
  list.innerHTML=""; empty.textContent="Đang tải…";
  try{
    const filter = muaban.filters.ProductCreated();
    const logs = await providerRO.getLogs({ address: CONFIG.MUABAN_ADDR, topics: filter.topics, fromBlock: 0, toBlock: "latest" });
    const ids = [...new Set(logs.map(l => muaban.interface.parseLog(l).args.productId.toString()))];
    if (!ids.length){ empty.textContent="Chưa có sản phẩm."; return; }
    empty.textContent="";
    for(const id of ids){
      const p = await muaban.getProduct(id);
      drawProductCard(p);
    }
  }catch(e){
    empty.textContent="Không tải được sản phẩm.";
  }
}
function drawProductCard(p){
  const id = p.productId.toString();
  const price = Number(p.priceVND.toString());
  const active = !!p.active;
  const seller = (p.seller||"").toLowerCase();
  const mine = account && seller === account.toLowerCase();
  const status = active ? "Còn hàng" : "Tắt bán";
  const isVideo = (p.imageCID||"").match(/\.(mp4|webm)$/i);

  const card = document.createElement("div");
  card.className = "card";
  card.innerHTML = `
    ${isVideo ? `<video src="${esc(p.imageCID)}" controls style="width:100%;height:180px;object-fit:cover"></video>`
              : `<img src="${esc(p.imageCID)}" alt="image">`}
    <div class="card-body">
      <div class="card-title">${esc(p.name)} <span class="muted mono">#${id}</span></div>
      <div class="muted mono" style="word-break:break-all">${esc(p.imageCID)}</div>
      <div class="card-price">${fmtVND(price)} VND</div>
      <div class="card-meta">${status} • giao tối đa ${p.deliveryDaysMax} ngày</div>
      <div class="row" style="gap:.4rem;margin-top:.4rem">
        ${renderCardButtons({ mine, active, id, price })}
      </div>
    </div>`;
  $("#list").appendChild(card);
  attachCardEvents(card, { mine, active, id, price });
}
function renderCardButtons({ mine, active, id }){
  if(!account) return "";
  if(mine){
    return `<button class="btn ghost" data-act="update" data-id="${id}">Cập nhật</button>
            <button class="btn" data-act="toggle" data-id="${id}">${active?"Tắt bán":"Bật bán"}</button>`;
  }else{
    return active ? `<button class="btn secondary" data-act="buy" data-id="${id}">Mua</button>` : ``;
  }
}
function attachCardEvents(card, ctx){
  card.querySelector('[data-act="update"]')?.addEventListener("click",()=>openUpdate(ctx.id));
  card.querySelector('[data-act="toggle"]')?.addEventListener("click",()=>toggleProduct(ctx.id,!ctx.active));
  card.querySelector('[data-act="buy"]')?.addEventListener("click",()=>openBuy(ctx.id, ctx.price));
}
/* Tìm kiếm client-side */
function searchProducts(){
  const q = ($("#q")?.value||"").toLowerCase().trim();
  $$("#list .card").forEach(c=>{
    const title = (c.querySelector(".card-title")?.textContent||"").toLowerCase();
    c.style.display = title.includes(q) ? "" : "none";
  });
}

/* =====================================================================================
   8) Đăng ký — KHÔNG còn approve lặt vặt, chỉ gọi payRegistration()
   ===================================================================================== */
function openRegister(){ $("#register-msg").textContent=""; $("#dlg-register").showModal(); }

async function doRegister(){
  try{
    // đảm bảo allowance đủ REG_FEE
    const fee = await muaban.REG_FEE();
    const ok = await hasSufficientAllowance(fee);
    if (!ok) return alert("Hãy bấm “Phê duyệt VIN (một lần)” trước (approve lớn).");

    const overrides = await buildOverrides("simple");
    const tx = await muaban.payRegistration(overrides);
    $("#register-msg").textContent="Đang gửi giao dịch…";
    await tx.wait();
    $("#register-msg").textContent="Đăng ký thành công!";
    $("#dlg-register").close();
    await refreshRegistration();
  }catch(e){
    console.error(e);
    $("#register-msg").textContent = "Lỗi: " + (e?.message||e);
  }
}

/* =====================================================================================
   9) Tạo/Cập nhật SP
   ===================================================================================== */
function openCreate(){
  if(!account) return alert("Hãy kết nối ví.");
  $("#create-msg").textContent=""; $("#form-create").reset(); $("#dlg-create").showModal();
}
async function submitCreate(ev){
  ev.preventDefault();
  try{
    const fd = new FormData(ev.target);
    const name = (fd.get("name")||"") + (fd.get("unit") ? " / " + fd.get("unit") : "");
    const imageCID = fd.get("imageCID");
    const priceVND = Number(fd.get("priceVND"));
    const payoutWallet = fd.get("payoutWallet");
    const days = Number(fd.get("deliveryDaysMax"));
    const reg = await muaban.registered(account);
    if(!reg) return alert("Cần đăng ký trước khi đăng SP.");

    const overrides = await buildOverrides("simple");
    const tx = await muaban.createProduct(name, "", imageCID, priceVND, days, payoutWallet, true, overrides);
    $("#create-msg").textContent="Đang gửi…";
    await tx.wait();
    $("#dlg-create").close();
    await renderProducts();
    alert("Đăng sản phẩm thành công!");
  }catch(e){ $("#create-msg").textContent="Lỗi: " + (e?.message||e); }
}
async function openUpdate(productId){
  $("#update-msg").textContent=""; $("#form-update").reset();
  const p = await muaban.getProduct(productId);
  if (p.seller.toLowerCase() !== account.toLowerCase()) return alert("Bạn không phải người bán.");
  $("#form-update [name=productId]").value = productId;
  $("#form-update [name=priceVND]").value = Number(p.priceVND.toString());
  $("#form-update [name=deliveryDaysMax]").value = Number(p.deliveryDaysMax.toString());
  $("#form-update [name=payoutWallet]").value = p.payoutWallet;
  $("#form-update [name=active]").value = p.active ? "true" : "false";
  $("#dlg-update").showModal();
}
async function submitUpdate(ev){
  ev.preventDefault();
  try{
    const fd = new FormData(ev.target);
    const pid = fd.get("productId");
    const priceVND = Number(fd.get("priceVND"));
    const days = Number(fd.get("deliveryDaysMax"));
    const payout = fd.get("payoutWallet");
    const active = fd.get("active")==="true";

    const overrides = await buildOverrides("simple");
    const tx = await muaban.updateProduct(pid, priceVND, days, payout, active, overrides);
    $("#update-msg").textContent="Đang gửi…";
    await tx.wait();
    $("#dlg-update").close();
    await renderProducts();
    alert("Cập nhật thành công!");
  }catch(e){ $("#update-msg").textContent="Lỗi: " + (e?.message||e); }
}
async function toggleProduct(pid, toActive){
  try{
    const overrides = await buildOverrides("simple");
    const tx = await muaban.setProductActive(pid, toActive, overrides);
    await tx.wait(); await renderProducts();
  }catch(e){ alert("Không đổi được trạng thái: "+(e?.message||e)); }
}

/* =====================================================================================
   10) Mua hàng — KHÔNG approve lặp lại; chỉ call placeOrder()
   ===================================================================================== */
function openBuy(productId, priceVND){
  if(!account) return alert("Hãy kết nối ví.");
  $("#buy-msg").textContent=""; $("#form-buy").reset();
  $("#form-buy [name=productId]").value = productId;
  $("#dlg-buy").showModal();

  const qty = $("#buy-qty");
  const out = $("#buy-total-vin");
  const render = async ()=>{
    if(!vinPerVNDWei) await refreshRates();
    const q = Math.max(1, Number(qty.value||1));
    const wei = ethers.BigNumber.from(priceVND.toString())
      .mul(ethers.BigNumber.from(q.toString()))
      .mul(ethers.BigNumber.from(vinPerVNDWei.toString()));
    out.textContent = ethers.utils.formatUnits(wei, 18);
  };
  qty.addEventListener("input", render);
  render();
}

async function submitBuy(ev){
  ev.preventDefault();
  try{
    if(!vinPerVNDWei) await refreshRates();

    const fd = new FormData(ev.target);
    const pid = fd.get("productId");
    const qty = Math.max(1, Number(fd.get("quantity")||1));

    const p = await muaban.getProduct(pid);
    if(!p.active) return alert("Sản phẩm đang tắt bán.");

    const needWei = ethers.BigNumber.from(p.priceVND.toString())
      .mul(ethers.BigNumber.from(qty.toString()))
      .mul(ethers.BigNumber.from(vinPerVNDWei.toString()));

    // Kiểm tra allowance -> yêu cầu bấm nút approve-once nếu thiếu
    const ok = await hasSufficientAllowance(needWei);
    if(!ok) return alert("Thiếu allowance VIN. Hãy bấm “Phê duyệt VIN (một lần)” ở thanh công cụ.");

    // Cipher (demo base64) — bạn có thể thay AES
    const info = {
      fullName: fd.get("fullName"),
      phone: fd.get("phone"),
      address: fd.get("address"),
      note: fd.get("note")
    };
    const cipher = btoa(unescape(encodeURIComponent(JSON.stringify(info))));

    const overrides = await buildOverrides("order");
    const tx = await muaban.placeOrder(pid, qty, vinPerVNDWei.toString(), cipher, overrides);
    $("#buy-msg").textContent="Đang gửi đơn…";
    const rc = await tx.wait();
    $("#buy-msg").textContent="Đặt hàng thành công!";
    $("#dlg-buy").close();

    // nếu bảng đơn mua đang mở thì refresh
    if ($("#dlg-buyer-orders").open) await listBuyerOrders();
  }catch(e){ $("#buy-msg").textContent="Lỗi: "+(e?.message||e); }
}

/* =====================================================================================
   11) Đơn hàng — Buyer & Seller (dựa trên event OrderPlaced)
   ===================================================================================== */
async function listBuyerOrders(){
  if(!account) return;
  $("#dlg-buyer-orders").showModal();
  const body = $("#buyer-orders-body");
  body.innerHTML="<tr><td colspan='7'>Đang tải…</td></tr>";
  try{
    const filter = muaban.filters.OrderPlaced(null,null,account);
    const logs = await providerRO.getLogs({ address: CONFIG.MUABAN_ADDR, topics: filter.topics, fromBlock: 0, toBlock:"latest" });
    if(!logs.length){ body.innerHTML="<tr><td colspan='7' class='muted'>Chưa có đơn hàng.</td></tr>"; return; }
    body.innerHTML="";
    for(const l of logs){
      const ev = muaban.interface.parseLog(l);
      const orderId = ev.args.orderId.toString();
      const o = await muaban.getOrder(orderId);
      const p = await muaban.getProduct(o.productId.toString());
      body.appendChild(renderBuyerRow(o,p));
    }
  }catch{ body.innerHTML="<tr><td colspan='7'>Không tải được.</td></tr>"; }
}
function renderBuyerRow(o,p){
  const tr=document.createElement("tr");
  const deadline = new Date(Number(o.deadline.toString())*1000).toLocaleString();
  const status = ["NONE","PLACED","RELEASED","REFUNDED"][Number(o.status)];
  tr.innerHTML = `
    <td class="mono">#${o.orderId}</td>
    <td>${esc(p.name)}</td>
    <td>${o.quantity}</td>
    <td class="mono">${Number(ethers.utils.formatUnits(o.vinAmount,18)).toFixed(6)}</td>
    <td>${deadline}</td>
    <td>${status}</td>
    <td>
      ${Number(o.status)===1 ? `
        <button class="btn ghost" data-act="confirm" data-id="${o.orderId}">Xác nhận đã nhận</button>
        <button class="btn" data-act="refund" data-id="${o.orderId}">Hoàn tiền</button>` : ``}
    </td>`;
  tr.querySelector('[data-act="confirm"]')?.addEventListener("click",()=>confirmReceipt(o.orderId.toString()));
  tr.querySelector('[data-act="refund"]')?.addEventListener("click",()=>refundIfExpired(o.orderId.toString()));
  return tr;
}

async function listSellerOrders(){
  if(!account) return;
  $("#dlg-seller-orders").showModal();
  const body=$("#seller-orders-body");
  body.innerHTML="<tr><td colspan='7'>Đang tải…</td></tr>";
  try{
    const filter = muaban.filters.OrderPlaced();
    const logs = await providerRO.getLogs({ address: CONFIG.MUABAN_ADDR, topics: filter.topics, fromBlock: 0, toBlock:"latest" });
    let any=false; body.innerHTML="";
    for(const l of logs){
      const ev = muaban.interface.parseLog(l);
      const orderId = ev.args.orderId.toString();
      const o = await muaban.getOrder(orderId);
      const p = await muaban.getProduct(o.productId.toString());
      if ((p.seller||"").toLowerCase() !== account.toLowerCase()) continue;
      any=true; body.appendChild(renderSellerRow(o,p));
    }
    if(!any) body.innerHTML="<tr><td colspan='7' class='muted'>Chưa có đơn bán.</td></tr>";
  }catch{ body.innerHTML="<tr><td colspan='7'>Không tải được.</td></tr>"; }
}
function renderSellerRow(o,p){
  const tr=document.createElement("tr");
  const deadline = new Date(Number(o.deadline.toString())*1000).toLocaleString();
  const status = ["NONE","PLACED","RELEASED","REFUNDED"][Number(o.status)];
  tr.innerHTML = `
    <td class="mono">#${o.orderId}</td>
    <td class="mono">${short(o.buyer)}</td>
    <td>${esc(p.name)}</td>
    <td>${o.quantity}</td>
    <td class="mono">${Number(ethers.utils.formatUnits(o.vinAmount,18)).toFixed(6)}</td>
    <td>${deadline}</td>
    <td>${status}</td>`;
  return tr;
}

async function confirmReceipt(orderId){
  try{
    const overrides = await buildOverrides("simple");
    const tx = await muaban.confirmReceipt(orderId, overrides);
    await tx.wait();
    await listBuyerOrders();
    alert("Đã xác nhận đã nhận hàng.");
  }catch(e){ alert("Lỗi xác nhận: " + (e?.message||e)); }
}
async function refundIfExpired(orderId){
  try{
    const overrides = await buildOverrides("simple");
    const tx = await muaban.refundIfExpired(orderId, overrides);
    await tx.wait();
    await listBuyerOrders();
    alert("Đã yêu cầu hoàn tiền (nếu quá hạn).");
  }catch(e){ alert("Lỗi hoàn tiền: " + (e?.message||e)); }
}

/* =====================================================================================
   12) Bind UI
   ===================================================================================== */
function bindUI(){
  $("#btn-connect")?.addEventListener("click", connectWallet);

  $("#btn-register")?.addEventListener("click", openRegister);
  $("#btn-register-confirm")?.addEventListener("click", doRegister);

  $("#btn-create")?.addEventListener("click", openCreate);
  $("#form-create")?.addEventListener("submit", submitCreate);

  $("#form-update")?.addEventListener("submit", submitUpdate);

  $("#form-buy")?.addEventListener("submit", submitBuy);

  $("#btn-buyer-orders")?.addEventListener("click", ()=>{ $("#dlg-buyer-orders").showModal(); listBuyerOrders(); });
  $("#btn-seller-orders")?.addEventListener("click", ()=>{ $("#dlg-seller-orders").showModal(); listSellerOrders(); });

  $("#btn-search")?.addEventListener("click", searchProducts);
  $("#q")?.addEventListener("keyup", (e)=>{ if(e.key==="Enter") searchProducts(); });
}
