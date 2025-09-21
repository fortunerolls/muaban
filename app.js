/* app.js — Muaban.vin (ethers v6, full features)
   - Network: Viction (chainId 88), RPC: https://rpc.viction.xyz, Explorer: https://vicscan.xyz
   - Legacy tx (type:0 + gasPrice + gasLimit) để tránh "Internal JSON-RPC error"
   - Tính tỷ giá VIN/VND và vinPerVND (wei cho 1 VND)
   - Đăng ký ví, đăng/cập nhật SP, mua hàng (mã hóa base64), liệt kê đơn buyer/seller qua event logs
   - Hành động buyer: confirmReceipt / refundIfExpired
*/

(() => {
  // ---------- DOM helpers ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const fmt = {
    vnd(n) { try { return Number(n).toLocaleString("vi-VN"); } catch { return String(n); } },
    vin(wei) { try { return Number(ethers.formatUnits(wei, 18)).toLocaleString("en-US", {maximumFractionDigits:6}); } catch { return String(wei); } },
  };
  const short = a => a ? a.slice(0,6) + "…" + a.slice(-4) : "";

  function toast(msg, ms = 2600) {
    const t = $("#toast"); if (!t) return alert(msg);
    t.textContent = msg; t.classList.remove("hidden"); t.classList.add("show");
    clearTimeout(t._h); t._h = setTimeout(()=>t.classList.remove("show"), ms);
  }

  // ---------- Global config/state ----------
  const C = window.MB_CONFIG || {};
  const VIC_CHAIN_ID_HEX = C?.VIC?.CHAIN_ID_HEX || "0x58";
  const VIC_EXPLORER = C?.VIC?.EXPLORER || "https://vicscan.xyz";
  const GAS = { light: 200000n, med: 450000n, heavy: 800000n };
  const GAS_PRICE_FALLBACK = ethers.parseUnits("60", "gwei"); // có thể tăng nếu pending

  let provider, signer, account;
  let muaban, vin, abiMuaban, abiVin;

  let priceVIN_VND = null;     // float
  let vinPerVND = null;        // BigInt wei cho 1 VND
  const productCache = new Map(); // pid -> product
  let orderCache = new Map();     // oid -> order (enriched)

  // ---------- Network helpers ----------
  async function ensureVictionAfterUnlock() {
    const eth = window.ethereum;
    if (!eth) throw new Error("Vui lòng cài MetaMask!");
    const chainId = await eth.request({ method: "eth_chainId" });
    if (chainId === VIC_CHAIN_ID_HEX) return;
    try {
      await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: VIC_CHAIN_ID_HEX }] });
    } catch (err) {
      if (err && err.code === 4902) {
        await eth.request({
          method: "wallet_addEthereumChain",
          params: [{
            chainId: VIC_CHAIN_ID_HEX,
            chainName: C?.VIC?.CHAIN_NAME || "Viction Mainnet",
            nativeCurrency: C?.VIC?.NATIVE_CURRENCY || { name:"VIC", symbol:"VIC", decimals:18 },
            rpcUrls: C?.VIC?.RPC_URLS || ["https://rpc.viction.xyz"],
            blockExplorerUrls: [VIC_EXPLORER]
          }]
        });
      } else { throw err; }
    }
  }

  // ---------- Ethers init ----------
  async function initEthers() {
    await ensureVictionAfterUnlock();

    provider = new ethers.BrowserProvider(window.ethereum);
    const net = await provider.getNetwork();
    if (Number(net.chainId) !== 88) throw new Error("Sai mạng. Hãy chuyển sang Viction.");

    signer = await provider.getSigner();
    account = (await signer.getAddress());

    if (!abiMuaban) abiMuaban = await fetch("Muaban_ABI.json", {cache:"no-store"}).then(r=>r.json());
    if (!abiVin)    abiVin    = await fetch("VinToken_ABI.json", {cache:"no-store"}).then(r=>r.json());

    muaban = new ethers.Contract(C.MUABAN_ADDRESS, abiMuaban, signer);
    vin    = new ethers.Contract(C.VIN_TOKEN,      abiVin,    signer);
  }

  // ---------- Legacy overrides ----------
  async function legacyOverrides(kind = "med") {
    let fee = await provider.getFeeData().catch(()=>null);
    const gasPrice = fee?.gasPrice ?? GAS_PRICE_FALLBACK;
    const gasLimit =
      kind === "heavy" ? GAS.heavy :
      kind === "light" ? GAS.light : GAS.med;
    return { type: 0, gasPrice, gasLimit };
  }

  // ---------- Pricing ----------
  async function fetchPricing() {
    try {
      // VIC/USDT (Binance)
      const res1 = await fetch(C.BINANCE_VIC_USDT, { cache: "no-store" });
      const vicUsdt = Number((await res1.json())?.price || 0);
      // USDT/VND (CoinGecko)
      const res2 = await fetch(C.COINGECKO_USDT_VND, { cache: "no-store" });
      const usdtVnd = Number((await res2.json())?.tether?.vnd || 0);
      if (!vicUsdt || !usdtVnd) throw new Error("Không lấy được giá.");

      priceVIN_VND = vicUsdt * 100 * usdtVnd; // 1 VIN = 100 VIC
      $("#vin-vnd-value").textContent = fmt.vnd(priceVIN_VND);

      const ONE = 10n ** 18n;
      const denom = BigInt(Math.floor(priceVIN_VND)); // VND/1 VIN
      vinPerVND = denom > 0n ? ONE / denom : null;
      if (vinPerVND !== null && vinPerVND <= 0n) vinPerVND = 1n;
    } catch (e) {
      console.warn("fetchPricing:", e);
      $("#vin-vnd-value").textContent = "—";
      priceVIN_VND = null; vinPerVND = null;
    }
  }
  function startPriceTicker(){ fetchPricing(); setInterval(fetchPricing, 45000); }

  // ---------- Wallet / UI ----------
  async function connectWallet() {
    try {
      await ensureVictionAfterUnlock();
      await window.ethereum.request({ method: "eth_requestAccounts" });
      await initEthers();
      await refreshWalletUI();
      toast("Đã kết nối ví.");
    } catch (e) {
      console.error(e); toast("Kết nối ví thất bại.");
    }
  }

  async function refreshWalletUI() {
    const addr = account;
    const vicBalWei = await provider.getBalance(addr);
    const vinBalWei = await vin.balanceOf(addr);

    $("#balVIC").textContent = Number(ethers.formatUnits(vicBalWei, 18)).toFixed(4);
    $("#balVIN").textContent = Number(ethers.formatUnits(vinBalWei, 18)).toFixed(4);
    $("#addrShort").textContent = short(addr);
    $("#addrShort").href = `${VIC_EXPLORER}/address/${addr}`;

    $("#btnConnect").classList.add("hidden");
    $("#walletInfo").classList.remove("hidden");

    $("#lnkContract").href = `${VIC_EXPLORER}/address/${C.MUABAN_ADDRESS}`;
    $("#lnkVIN").href = `${VIC_EXPLORER}/address/${C.VIN_TOKEN}`;

    await updateRegisterButton();
  }

  async function updateRegisterButton() {
    try {
      const registered = await muaban.registered(account);
      const btn = $("#btnRegister");
      if (registered) btn.classList.add("hidden"); else btn.classList.remove("hidden");
    } catch {}
  }

  // ---------- Allowance ----------
  async function ensureAllowance(spender, requiredWei, kind = "light") {
    const cur = await vin.allowance(account, spender);
    if (cur >= requiredWei) return;
    toast("Đang approve VIN…");
    const tx = await vin.approve(spender, requiredWei, await legacyOverrides(kind));
    await tx.wait();
    toast("Approve xong.");
  }

  // ---------- Registration ----------
  async function doRegister() {
    try {
      if (!muaban) await initEthers();
      const REG_FEE = 10n ** 15n; // 0.001 VIN
      await ensureAllowance(C.MUABAN_ADDRESS, REG_FEE);
      toast("Đang đăng ký…");
      const tx = await muaban.payRegistration(await legacyOverrides("med"));
      await tx.wait();
      toast("Đăng ký thành công.");
      await updateRegisterButton();
      await refreshWalletUI();
    } catch (e) { console.error(e); toast("Đăng ký thất bại."); }
  }

  // ---------- Product helpers ----------
  function parseUnitFromDescCID(s){ const p=(s||"").trim(); return p.startsWith("unit:") ? p.slice(5).trim() : ""; }
  function buildDescCIDFromUnit(u){ return `unit:${(u||"").trim()}`; }

  // ---------- Create product ----------
  async function submitCreate() {
    try{
      if (!muaban) await initEthers();
      const name = ($("#createName").value||"").trim();
      const ipfs = ($("#createIPFS").value||"").trim();
      const unit = ($("#createUnit").value||"").trim();
      const priceVND = BigInt(Math.max(1, Number($("#createPrice").value||0)));
      const wallet = ($("#createWallet").value||"").trim();
      const days = Number($("#createDays").value||0);
      const active = $("#createActive").checked;
      if (!name || !ipfs || !unit || !priceVND || !wallet || !days){ toast("Vui lòng nhập đủ thông tin."); return; }

      const descriptionCID = buildDescCIDFromUnit(unit);
      const imageCID = ipfs;

      toast("Đang tạo sản phẩm…");
      const tx = await muaban.createProduct(name, descriptionCID, imageCID, priceVND, days, wallet, active, await legacyOverrides("heavy"));
      await tx.wait();
      toast("Đăng sản phẩm thành công.");
      // clear
      $("#createName").value = ""; $("#createIPFS").value = ""; $("#createUnit").value = "";
      $("#createPrice").value = ""; $("#createWallet").value = ""; $("#createDays").value = ""; $("#createActive").checked = true;

      await loadHomeProducts();
      await loadSellerStuff(); // cập nhật view seller
    }catch(e){ console.error(e); toast("Đăng sản phẩm thất bại."); }
  }

  // ---------- Update product ----------
  async function openUpdateModal(pid, product) {
    $("#updPid").value = String(pid);
    $("#updPrice").value = product?.priceVND || "";
    $("#updWallet").value = product?.payoutWallet || "";
    $("#updDays").value = product?.deliveryDaysMax || "";
    $("#updActive").checked = !!product?.active;
    $("#modalUpdate").classList.remove("hidden");
  }
  async function doUpdateProduct() {
    try{
      const pid = Number($("#updPid").value);
      const priceVND = BigInt(Math.max(1, Number($("#updPrice").value||0)));
      const payout = ($("#updWallet").value||"").trim();
      const days = Number($("#updDays").value||0);
      const active = $("#updActive").checked;
      if (!pid || !priceVND || !payout || !days){ toast("Thiếu dữ liệu cập nhật."); return; }

      toast("Đang cập nhật…");
      const tx = await muaban.updateProduct(pid, priceVND, days, payout, active, await legacyOverrides("med"));
      await tx.wait();
      toast("Cập nhật xong.");
      $("#modalUpdate").classList.add("hidden");
      await loadHomeProducts();
      await loadSellerStuff();
    }catch(e){ console.error(e); toast("Cập nhật thất bại."); }
  }

  // ---------- Scan products ----------
  const SCAN_LIMIT = 500;
  async function scanProducts(max = SCAN_LIMIT) {
    if (!muaban) await initEthers();
    $("#homeLoading").classList.remove("hidden");
    $("#homeEmpty").classList.add("hidden");

    const found = [];
    for (let pid = 1; pid <= max; pid++) {
      try {
        const p = await muaban.getProduct(pid);
        if (p && p.seller && p.seller !== ethers.ZeroAddress) {
          const obj = {
            productId: Number(p.productId),
            seller: p.seller,
            name: p.name,
            descriptionCID: p.descriptionCID,
            imageCID: p.imageCID,
            priceVND: Number(p.priceVND),
            deliveryDaysMax: Number(p.deliveryDaysMax),
            payoutWallet: p.payoutWallet,
            active: Boolean(p.active),
            createdAt: Number(p.createdAt || 0),
            updatedAt: Number(p.updatedAt || 0)
          };
          productCache.set(obj.productId, obj);
          found.push(obj);
        }
      } catch {}
    }
    $("#homeLoading").classList.add("hidden");
    if (!found.length) $("#homeEmpty").classList.remove("hidden");
    return found;
  }
  function renderProducts(list) {
    const grid = $("#productsList"); grid.innerHTML = "";
    const me = (account||"").toLowerCase();
    list.forEach(p=>{
      const tpl = $("#tplProductCard");
      const node = tpl.content.firstElementChild.cloneNode(true);
      node.querySelector("[data-bind='imageCID']").src = p.imageCID || "";
      node.querySelector("[data-bind='name']").textContent = p.name || "—";
      node.querySelector("[data-bind='priceVND']").textContent = fmt.vnd(p.priceVND||0);
      node.querySelector("[data-bind='unit']").textContent = parseUnitFromDescCID(p.descriptionCID) || "đơn vị";
      node.querySelector("[data-bind='activeText']").textContent = p.active ? "Còn hàng":"Hết hàng";
      const btnBuy = node.querySelector("[data-action='buy']");
      const btnUpd = node.querySelector("[data-action='update']");
      if (!p.active) btnBuy.classList.add("hidden");
      if (me && me === p.seller.toLowerCase()) btnUpd.classList.remove("hidden");
      btnBuy.addEventListener("click", ()=>openBuyModal(p.productId));
      btnUpd.addEventListener("click", ()=>openUpdateModal(p.productId, p));
      grid.appendChild(node);
    });
  }
  async function loadHomeProducts() {
    const q = ($("#searchInput").value||"").trim().toLowerCase();
    let all = await scanProducts(SCAN_LIMIT);
    if (q) all = all.filter(p => (p.name||"").toLowerCase().includes(q));
    renderProducts(all.slice(0, C?.PAGE_SIZE||20));
  }

  // ---------- BUY modal + placeOrder ----------
  function encodeBuyerInfo(obj){ return btoa(unescape(encodeURIComponent(JSON.stringify(obj||{})))); }

  async function openBuyModal(pid) {
    try{
      const p = productCache.get(pid) || await muaban.getProduct(pid);
      if (!p || !p.seller || p.seller === ethers.ZeroAddress){ toast("Sản phẩm không tồn tại."); return; }
      const obj = productCache.get(pid) || {
        productId: Number(p.productId), seller: p.seller, name: p.name,
        descriptionCID: p.descriptionCID, imageCID: p.imageCID, priceVND: Number(p.priceVND),
        deliveryDaysMax: Number(p.deliveryDaysMax), payoutWallet: p.payoutWallet, active: Boolean(p.active)
      };
      $("#buyImg").src = obj.imageCID || "";
      $("#buyName").textContent = obj.name || "—";
      $("#buyPriceVND").textContent = fmt.vnd(obj.priceVND||0);
      $("#buyUnit").textContent = parseUnitFromDescCID(obj.descriptionCID) || "đơn vị";
      $("#buyPayout").textContent = short(obj.payoutWallet);
      $("#buyPayout").href = `${VIC_EXPLORER}/address/${obj.payoutWallet}`;
      $("#buyDays").textContent = String(obj.deliveryDaysMax||0);
      $("#buyQty").value = 1; $("#buyTotalVIN").textContent = "—";

      const recalc = ()=>{
        const qty = Math.max(1, Number($("#buyQty").value||1));
        const totalVND = (obj.priceVND||0) * qty;
        if (priceVIN_VND) $("#buyTotalVIN").textContent = (totalVND/priceVIN_VND).toFixed(6);
      };
      $("#buyQty").oninput = recalc; recalc();
      $("#modalBuy").classList.remove("hidden");

      $("#btnPlaceOrder").onclick = async () => {
        try{
          if (!vinPerVND || vinPerVND<=0n){ toast("Chưa có tỷ giá VIN/VND."); return; }
          const fullname = ($("#buyFullname").value||"").trim();
          const phone = ($("#buyPhone").value||"").trim();
          const address = ($("#buyAddress").value||"").trim();
          const note = ($("#buyNote").value||"").trim();
          const qty = Math.max(1, Number($("#buyQty").value||1));
          if (!fullname || !phone || !address){ toast("Nhập đủ Họ tên / SĐT / Địa chỉ."); return; }

          const totalVND = BigInt((obj.priceVND||0) * qty);
          const vinAmount = totalVND * vinPerVND; // ceil trong hợp đồng đã đảm bảo
          await ensureAllowance(C.MUABAN_ADDRESS, vinAmount);

          const cipher = encodeBuyerInfo({ fullname, phone, address, note });
          toast("Đang gửi đơn (placeOrder)…");
          const tx = await muaban.placeOrder(obj.productId, qty, vinPerVND, cipher, await legacyOverrides("med"));
          await tx.wait();
          toast("Đặt hàng thành công.");
          $("#modalBuy").classList.add("hidden");

          await loadBuyerOrders(); // cập nhật tab buyer
        }catch(e){ console.error(e); toast("Đặt hàng thất bại."); }
      };
    }catch(e){ console.error(e); toast("Không mở được cửa sổ mua."); }
  }

  // ---------- Orders (scan events, render, actions) ----------
  async function scanOrders() {
    // Lấy tất cả OrderPlaced để có danh sách orderId
    const iface = new ethers.Interface(abiMuaban);
    const topic = iface.getEvent("OrderPlaced").topicHash;
    // Đọc logs qua provider của signer (same RPC)
    const logs = await provider.send("eth_getLogs", [{
      fromBlock: "0x0",
      toBlock: "latest",
      address: C.MUABAN_ADDRESS,
      topics: [topic]
    }]);
    const oids = [];
    for (const l of logs) {
      try {
        const parsed = iface.decodeEventLog("OrderPlaced", l.data, l.topics);
        const oid = Number(parsed[0]); // orderId
        oids.push(oid);
      } catch {}
    }
    // Đọc chi tiết
    const orders = [];
    for (const oid of oids) {
      try {
        const o = await muaban.getOrder(oid);
        if (o && o.orderId && Number(o.orderId) > 0) {
          const p = await muaban.getProduct(Number(o.productId));
          orders.push({
            orderId: Number(o.orderId),
            productId: Number(o.productId),
            buyer: o.buyer,
            seller: o.seller,
            quantity: Number(o.quantity),
            vinAmount: o.vinAmount,
            placedAt: Number(o.placedAt),
            deadline: Number(o.deadline),
            status: Number(o.status), // 1:PLACED 2:RELEASED 3:REFUNDED
            buyerInfoCipher: o.buyerInfoCipher,
            productName: p.name
          });
        }
      } catch {}
    }
    // cache
    orderCache = new Map(orders.map(x=>[x.orderId, x]));
    return orders;
  }

  function statusText(s){
    if (s===1) return "Đã đặt (escrow)";
    if (s===2) return "Đã giải ngân";
    if (s===3) return "Đã hoàn tiền";
    return "—";
  }
  function tsToStr(t){ try { return new Date(t*1000).toLocaleString("vi-VN"); } catch { return String(t); } }

  function renderOrders(list, targetId, role){
    const box = $(targetId); box.innerHTML = "";
    if (!list.length){
      if (targetId==="#buyerOrders") $("#buyerEmpty").classList.remove("hidden");
      if (targetId==="#sellerOrders") $("#sellerOrdersEmpty").classList.remove("hidden");
      return;
    }
    if (targetId==="#buyerOrders") $("#buyerEmpty").classList.add("hidden");
    if (targetId==="#sellerOrders") $("#sellerOrdersEmpty").classList.add("hidden");

    list.sort((a,b)=>b.orderId - a.orderId).forEach(o=>{
      const tpl = $("#tplOrderItem");
      const node = tpl.content.firstElementChild.cloneNode(true);
      node.querySelector("[data-bind='orderId']").textContent = o.orderId;
      node.querySelector("[data-bind='productName']").textContent = o.productName || `#${o.productId}`;
      node.querySelector("[data-bind='quantity']").textContent = o.quantity;
      node.querySelector("[data-bind='vinAmount']").textContent = fmt.vin(o.vinAmount);
      node.querySelector("[data-bind='deadline']").textContent = tsToStr(o.deadline);
      node.querySelector("[data-bind='status']").textContent = statusText(o.status);

      const btnConfirm = node.querySelector("[data-action='confirm']");
      const btnRefund  = node.querySelector("[data-action='refund']");

      // Hiển thị nút theo role + trạng thái
      if (role === "buyer" && o.status === 1){
        btnConfirm.classList.remove("hidden");
        btnRefund.classList.remove("hidden");
      }
      // seller không có hành động trong hợp đồng hiện tại

      btnConfirm.addEventListener("click", ()=>confirmReceipt(o.orderId));
      btnRefund.addEventListener("click", ()=>refundIfExpired(o.orderId));

      box.appendChild(node);
    });
  }

  async function loadBuyerOrders(){
    try{
      const all = await scanOrders();
      const mine = all.filter(o => o.buyer.toLowerCase() === account.toLowerCase());
      renderOrders(mine, "#buyerOrders", "buyer");
    }catch(e){ console.error(e); $("#buyerEmpty").classList.remove("hidden"); }
  }
  async function loadSellerOrders(){
    try{
      const all = await scanOrders();
      const mine = all.filter(o => o.seller.toLowerCase() === account.toLowerCase());
      renderOrders(mine, "#sellerOrders", "seller");
    }catch(e){ console.error(e); $("#sellerOrdersEmpty").classList.remove("hidden"); }
  }

  async function confirmReceipt(orderId){
    try{
      toast("Đang xác nhận đã nhận hàng…");
      const tx = await muaban.confirmReceipt(orderId, await legacyOverrides("light"));
      await tx.wait();
      toast("Đã giải ngân cho người bán.");
      await loadBuyerOrders();
      await loadSellerOrders();
    }catch(e){ console.error(e); toast("Xác nhận thất bại."); }
  }
  async function refundIfExpired(orderId){
    try{
      toast("Đang yêu cầu hoàn tiền…");
      const tx = await muaban.refundIfExpired(orderId, await legacyOverrides("light"));
      await tx.wait();
      toast("Đã hoàn tiền.");
      await loadBuyerOrders();
      await loadSellerOrders();
    }catch(e){ console.error(e); toast("Hoàn tiền thất bại (chưa quá hạn?)."); }
  }

  // ---------- Seller dashboard ----------
  async function loadSellerStuff(){
    try{
      // Sản phẩm của tôi
      $("#sellerProducts").innerHTML = "";
      const ids = await muaban.getSellerProductIds(account);
      if (!ids || !ids.length) $("#sellerEmpty").classList.remove("hidden"); else $("#sellerEmpty").classList.add("hidden");
      for (const pid of ids){
        const p = await muaban.getProduct(Number(pid));
        const row = document.createElement("div");
        row.className = "row order";
        row.innerHTML = `
          <div class="col">
            <div>PID: <b>#${Number(p.productId)}</b> — ${p.name}</div>
            <div>Giá: <b>${fmt.vnd(Number(p.priceVND))}</b> VND • Max giao: ${Number(p.deliveryDaysMax)} ngày • Trạng thái: ${p.active ? "Đang bán":"Tắt"}</div>
          </div>
          <div class="col actions">
            <button class="btn outline" data-pid="${Number(p.productId)}">Cập nhật</button>
          </div>`;
        row.querySelector("button").onclick = ()=>openUpdateModal(Number(p.productId), {
          priceVND: Number(p.priceVND),
          payoutWallet: p.payoutWallet,
          deliveryDaysMax: Number(p.deliveryDaysMax),
          active: Boolean(p.active)
        });
        $("#sellerProducts").appendChild(row);
      }

      // Đơn của tôi (seller)
      await loadSellerOrders();
    }catch(e){ console.error(e); $("#sellerEmpty").classList.remove("hidden"); $("#sellerOrdersEmpty").classList.remove("hidden"); }
  }

  // ---------- Navigation ----------
  function showScreen(id){
    $$(".screen").forEach(s=>s.classList.add("hidden"));
    $(id).classList.remove("hidden");
    $$(".subnav .tab").forEach(b=>b.classList.remove("active"));
    if (id==="#screenHome")   $("#navHome").classList.add("active");
    if (id==="#screenCreate") $("#navCreate").classList.add("active");
    if (id==="#screenBuyer")  $("#navBuyer").classList.add("active");
    if (id==="#screenSeller") $("#navSeller").classList.add("active");
  }

  // ---------- Bind events ----------
  function bindEvents(){
    $("#btnConnect").addEventListener("click", connectWallet);
    $("#btnRegister").addEventListener("click", doRegister);

    $("#btnSearch").addEventListener("click", loadHomeProducts);
    $("#searchInput").addEventListener("keypress", e=>{ if (e.key==="Enter") loadHomeProducts(); });

    $("#navHome").addEventListener("click", async ()=>{ showScreen("#screenHome"); await loadHomeProducts(); });
    $("#navCreate").addEventListener("click", ()=>{ showScreen("#screenCreate"); });
    $("#navBuyer").addEventListener("click", async ()=>{ showScreen("#screenBuyer"); await loadBuyerOrders(); });
    $("#navSeller").addEventListener("click", async ()=>{ showScreen("#screenSeller"); await loadSellerStuff(); });

    $("#btnCreate").addEventListener("click", submitCreate);

    $("#buyClose").addEventListener("click", ()=>$("#modalBuy").classList.add("hidden"));
    $("#btnBuyCancel").addEventListener("click", ()=>$("#modalBuy").classList.add("hidden"));
    $("#updClose").addEventListener("click", ()=>$("#modalUpdate").classList.add("hidden"));
    $("#btnUpdCancel").addEventListener("click", ()=>$("#modalUpdate").classList.add("hidden"));
    $("#btnDoUpdate").addEventListener("click", doUpdateProduct);

    if (window.ethereum){
      window.ethereum.on("accountsChanged", ()=>location.reload());
      window.ethereum.on("chainChanged",   ()=>location.reload());
    }
  }

  // ---------- Init ----------
  async function init(){
    bindEvents();
    startPriceTicker();
    await loadHomeProducts(); // public view
  }
  document.addEventListener("DOMContentLoaded", init);
})();
