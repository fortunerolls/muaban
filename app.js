/* ========================================================================
   muaban.vin — app.js (FULL, fixed v3)
   - Ethers v5 (UMD)
   - Viction (chainId 88)
   - Giá: VND là SỐ NGUYÊN ≥ 1 (không thập phân)
   - Bỏ preflight gây hiểu nhầm trước khi ký: KHÔNG callStatic.createProduct nữa
   - Giao dịch có overrides an toàn (from, gasLimit, gasPrice) để tránh "Internal JSON-RPC error"
   - Đăng ký (approve → payRegistration) sẽ bật ký ví đúng lúc; không báo lỗi trước khi ví hiện
   - Hiển thị RÕ thông tin người bán (ví seller, ví nhận tiền/payout) + modal chi tiết + link VicScan
   - Toast + link VicScan cho mọi giao dịch; reload & highlight sản phẩm mới
   ======================================================================== */

(() => {
  // ---------------------- Chain constants ----------------------
  const VIC = {
    CHAIN_ID_DEC: 88,
    CHAIN_ID_HEX: "0x58",
    RPC_URL: "https://rpc.viction.xyz",
    EXPLORER: "https://www.vicscan.xyz",
    NAME: "Viction Mainnet",
    CURRENCY: { name: "VIC", symbol: "VIC", decimals: 18 }
  };

  // ---------------------- Contract addresses ----------------------
  const MUABAN_ADDR = "0x190FD18820498872354eED9C4C080cB365Cd12E0";
  const VIN_ADDR    = "0x941F63807401efCE8afe3C9d88d368bAA287Fac4";

  // ---------------------- Price endpoints ----------------------
  const BINANCE_VICUSDT = "https://api.binance.com/api/v3/ticker/price?symbol=VICUSDT";
  const COINGECKO_USDT_VND = "https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=vnd";

  // ---------------------- Scan config ----------------------
  const MAX_SCAN = 200;
  const MAX_EMPTY_STREAK = 20;

  // ---------------------- Minimal ABIs ----------------------
  const ERC20_ABI = [
    "function decimals() view returns (uint8)",
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function approve(address spender, uint256 value) returns (bool)"
  ];

  const MUABAN_ABI = [
    "function REG_FEE() view returns (uint256)",
    "function vin() view returns (address)",
    "function registered(address) view returns (bool)",

    "function payRegistration() external",
    "function createProduct(string name,string descriptionCID,string imageCID,uint256 priceVND,uint32 deliveryDaysMax,address payoutWallet,bool active) external returns (uint256 pid)",
    "function updateProduct(uint256 pid,uint256 priceVND,uint32 deliveryDaysMax,address payoutWallet,bool active) external",
    "function setProductActive(uint256 pid,bool active) external",

    "function getSellerProductIds(address seller) view returns (uint256[])",
    "function getProduct(uint256 pid) view returns (tuple(uint256 productId,address seller,string name,string descriptionCID,string imageCID,uint256 priceVND,uint32 deliveryDaysMax,address payoutWallet,bool active,uint64 createdAt,uint64 updatedAt))",

    "function placeOrder(uint256 productId,uint256 quantity,uint256 vinPerVND,string buyerInfoCipher) external returns (uint256 oid)",
    "function getOrder(uint256 oid) view returns (tuple(uint256 orderId,uint256 productId,address buyer,address seller,uint256 quantity,uint256 vinAmount,uint256 placedAt,uint256 deadline,uint8 status,string buyerInfoCipher))",
    "function confirmReceipt(uint256 orderId) external",
    "function refundIfExpired(uint256 orderId) external"
  ];

  // ---------------------- State ----------------------
  let provider, signer, account;
  let muaban, vin;
  let vinDecimals = 18;

  // Giá
  let priceVIC_USDT = null; // number
  let priceUSDT_VND = null; // number
  let vndPerVIN = null;         // number (tạm)
  let vndPerVIN_INT = null;     // number (SỐ NGUYÊN ≥ 1 — dùng để hiển thị/tính)
  let vinPerVNDWei = null;      // BigNumber (wei VIN per 1 VND)

  // ---------------------- UI refs ----------------------
  const $ = (id) => document.getElementById(id);
  const $vinPrice = $("vinPrice");
  const $btnConnect = $("btnConnect");
  const $walletBox = $("walletBox");
  const $vinBalance = $("vinBalance");
  const $vicBalance = $("vicBalance");
  const $accountShort = $("accountShort");
  const $btnDisconnect = $("btnDisconnect");

  const $menuBox = $("menuBox");
  const $btnRegister = $("btnRegister");
  const $btnCreate = $("btnCreate");
  const $btnOrdersBuy = $("btnOrdersBuy");
  const $btnOrdersSell = $("btnOrdersSell");

  const $searchInput = $("searchInput");
  const $btnSearch = $("btnSearch");
  const $productList = $("productList");

  // Modals & fields
  const $formCreate = $("formCreate");
  const $createName   = $("createName");
  const $createIPFS   = $("createIPFS");
  const $createUnit   = $("createUnit"); // client-side only
  const $createPrice  = $("createPrice");
  const $createWallet = $("createWallet");
  const $createDays   = $("createDays");
  const $btnSubmitCreate = $("btnSubmitCreate");

  const $formUpdate = $("formUpdate");
  const $updatePid   = $("updatePid");
  const $updatePrice = $("updatePrice");
  const $updateDays  = $("updateDays");
  const $updateWallet= $("updateWallet");
  const $updateActive= $("updateActive");
  const $btnSubmitUpdate = $("btnSubmitUpdate");

  const $formBuy     = $("formBuy");
  const $buyProductInfo = $("buyProductInfo");
  const $buyName     = $("buyName");
  const $buyAddress  = $("buyAddress");
  const $buyPhone    = $("buyPhone");
  const $buyNote     = $("buyNote");
  const $buyQty      = $("buyQty");
  const $buyTotalVIN = $("buyTotalVIN");
  const $btnSubmitBuy= $("btnSubmitBuy");

  // ---------------------- Helpers ----------------------
  const short = (a) => a ? (a.slice(0,6)+"…"+a.slice(-4)) : "";
  const fmtVND = (n) => Number(n||0).toLocaleString("vi-VN");
  const fmtVIN = (wei) => { try { return ethers.utils.formatUnits(wei, vinDecimals); } catch(e){ return "0"; } };
  function escapeHtml(s){ return String(s).replace(/[&<>"']/g, (m)=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[m])); }
  function toHttpIPFS(link){ if(!link) return ""; return link.startsWith("ipfs://")?`https://ipfs.io/ipfs/${link.slice(7)}`:link; }
  const explorerTx = (hash) => `${VIC.EXPLORER}/tx/${hash}`;

  // ---- Toast UI ----
  let __toastWrap = null;
  function ensureToastHost(){
    if(__toastWrap) return __toastWrap;
    __toastWrap = document.createElement("div");
    __toastWrap.id = "toast-host";
    __toastWrap.style.cssText = "position:fixed;top:16px;right:16px;z-index:99999;display:flex;flex-direction:column;gap:10px;";
    document.body.appendChild(__toastWrap);
    return __toastWrap;
  }
  function uiToast(message, type="info", timeout=4200){
    const host = ensureToastHost();
    const box = document.createElement("div");
    box.style.cssText = `min-width:280px;max-width:520px;padding:12px 14px;border-radius:10px;box-shadow:0 6px 18px rgba(0,0,0,.12);font-size:14px;line-height:1.4;color:#0b1020;background:#fff;border-left:6px solid ${type==="success"?"#16a34a":type==="error"?"#ef4444":type==="warn"?"#f59e0b":"#3b82f6"}`;
    // Diệt thông báo JSON-RPC chung chung
    const safe = String(message||"").replace(/Internal JSON-RPC error\.?/gi, "Ví/RPC trả lỗi chung chung. Vui lòng kiểm tra: đã kết nối ví, đúng mạng Viction, đủ VIC phí gas, đã Đăng ký ví.");
    box.innerHTML = `<div style=\"font-weight:600;margin-bottom:4px;\">${type.toUpperCase()}</div><div>${safe}</div>`;
    host.appendChild(box);
    setTimeout(()=>{ box.style.opacity="0"; box.style.transform="translateY(-6px)"; box.style.transition="all .25s"; }, timeout-250);
    setTimeout(()=> host.removeChild(box), timeout);
  }

  // ---- Error prettifier ----
  function prettifyError(e){
    const raw = e?.error?.message || e?.data?.message || e?.reason || e?.message || String(e);
    if (/user rejected|denied|4001/i.test(raw)) return "Bạn đã từ chối ký giao dịch.";
    if (/insufficient funds/i.test(raw)) return "Ví không đủ VIC để trả phí gas.";
    if (/invalid address/i.test(raw)) return "Địa chỉ ví không hợp lệ.";
    if (/nonce too low/i.test(raw)) return "Nonce quá thấp. Hãy thử lại sau ít giây.";
    if (/replacement/i.test(raw)) return "Giao dịch bị thay thế/hủy. Hãy gửi lại.";
    if (/CALL_EXCEPTION|execution reverted|revert/i.test(raw)) return "Giao dịch bị revert trên chuỗi (kiểm tra tham số/allowance/đăng ký).";
    return raw;
  }

  // ---- TX helper: overrides an toàn cho MetaMask Mobile ----
  async function buildSafeOverrides(contract, method, args, provider, account){
    const ov = { from: account };
    // gasLimit an toàn
    try {
      const est = await contract.estimateGas[method](...args);
      ov.gasLimit = est.mul(130).div(100); // buffer 30%
    } catch (e) {
      ov.gasLimit = ethers.BigNumber.from("500000"); // fallback
      console.warn("[estimateGas failed] fallback gasLimit=500k", e);
    }
    // gasPrice an toàn
    try {
      const fee = await provider.getFeeData();
      let gp = fee.gasPrice;
      if (!gp || gp.isZero()) gp = ethers.utils.parseUnits("1", "gwei");
      ov.gasPrice = gp.mul(110).div(100); // buffer 10%
    } catch (e) {
      ov.gasPrice = ethers.utils.parseUnits("1", "gwei");
      console.warn("[getFeeData failed] fallback gasPrice=1 gwei", e);
    }
    return ov;
  }

  // ---------------------- Chain / Provider ----------------------
  async function ensureViction(){
    if(!window.ethereum){ uiToast("Không thấy ví (MetaMask).", "warn"); return false; }
    const eth = window.ethereum;
    const chainId = await eth.request({ method: "eth_chainId" });
    if(chainId === VIC.CHAIN_ID_HEX) return true;
    try{
      await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: VIC.CHAIN_ID_HEX }] });
      return true;
    }catch(err){
      if(err && err.code === 4902){
        await eth.request({ method: "wallet_addEthereumChain", params: [{ chainId: VIC.CHAIN_ID_HEX, chainName: VIC.NAME, nativeCurrency: VIC.CURRENCY, rpcUrls: [VIC.RPC_URL], blockExplorerUrls: [VIC.EXPLORER] }] });
        return true;
      }
      uiToast(`Không chuyển được chain: ${prettifyError(err)}`, "error", 6500);
      return false;
    }
  }

  async function connect(){
    if(!window.ethereum){ uiToast("No wallet found.", "warn"); return; }
    try{
      provider = new ethers.providers.Web3Provider(window.ethereum, "any");
      await provider.send("eth_requestAccounts", []);
      const ok = await ensureViction();
      if(!ok) return;
      signer = provider.getSigner();
      account = await signer.getAddress();

      await initContracts();
      await refreshWalletUI();
      await afterConnectedUI();

      window.ethereum?.on?.("accountsChanged", ()=> location.reload());
      window.ethereum?.on?.("chainChanged", ()=> location.reload());
    }catch(err){ uiToast(`Lỗi kết nối ví: ${prettifyError(err)}`, "error", 6500); }
  }

  function disconnect(){ location.reload(); }

  async function initContracts(){
    vin = new ethers.Contract(VIN_ADDR, ERC20_ABI, signer);
    try{ vinDecimals = Number(await vin.decimals())||18; }catch(_){ vinDecimals = 18; }
    muaban = new ethers.Contract(MUABAN_ADDR, MUABAN_ABI, signer);
  }

  async function refreshWalletUI(){
    try{
      const vicBal = await provider.getBalance(account);
      const vinBal = await vin.balanceOf(account);
      $vicBalance.textContent = `VIC: ${Number(ethers.utils.formatEther(vicBal)).toFixed(4)}`;
      $vinBalance.textContent = `VIN: ${Number(fmtVIN(vinBal)).toFixed(4)}`;
      $accountShort.textContent = short(account);
      $accountShort.href = `${VIC.EXPLORER}/address/${account}`;
      $btnConnect.classList.add("hidden");
      $walletBox.classList.remove("hidden");
    }catch(err){ uiToast(`Không đọc được số dư: ${prettifyError(err)}`, "error", 6500); }
  }

  async function afterConnectedUI(){
    try{
      const isReg = await muaban.registered(account);
      $menuBox.classList.remove("hidden");
      if(!isReg){
        $btnRegister.classList.remove("hidden");
        $btnCreate.classList.add("hidden");
        $btnOrdersBuy.classList.add("hidden");
        $btnOrdersSell.classList.add("hidden");
      }else{
        $btnRegister.classList.add("hidden");
        $btnCreate.classList.remove("hidden");
        $btnOrdersBuy.classList.remove("hidden");
        $btnOrdersSell.classList.remove("hidden");
      }
      await loadProducts();
    }catch(err){ uiToast(`Lỗi UI: ${prettifyError(err)}`, "error", 6500); }
  }

  // ---------------------- Pricing (VND NGUYÊN) ----------------------
  async function fetchPrices(){
    try{
      const b = await fetch(BINANCE_VICUSDT, { cache: "no-store" }).then(r=>r.json());
      priceVIC_USDT = Number(b?.price || 0);
      const c = await fetch(COINGECKO_USDT_VND, { cache: "no-store" }).then(r=>r.json());
      priceUSDT_VND = Number(c?.tether?.vnd || 0);

      if(!(priceVIC_USDT>0) || !(priceUSDT_VND>0)) throw new Error("Nguồn giá không khả dụng");

      // tạm tính có thể thập phân
      vndPerVIN = priceVIC_USDT * 100 * priceUSDT_VND;
      // CHỐT số NGUYÊN ≥ 1
      vndPerVIN_INT = Math.max(1, Math.round(vndPerVIN));

      // vinPerVNDWei = floor(1e18 / VND_per_VIN_int)
      const one = ethers.utils.parseUnits("1", vinDecimals);
      const denom = ethers.BigNumber.from(vndPerVIN_INT.toString());
      vinPerVNDWei = one.div(denom);

      if($vinPrice) $vinPrice.textContent = `1 VIN = ${vndPerVIN_INT.toLocaleString("vi-VN")} VND`;
    }catch(_){
      if($vinPrice) $vinPrice.textContent = "Loading price...";
      vinPerVNDWei = null; vndPerVIN_INT = null;
    }
  }

  // ---------------------- Registration ----------------------
  async function ensureRegisteredFlow(){
    // Không dùng callStatic ở đây để tránh lỗi trước khi ký; tiến thẳng approve → payRegistration nếu cần
    const isReg = await muaban.registered(account);
    if(isReg) return true;

    const fee = await muaban.REG_FEE();

    const alw = await vin.allowance(account, MUABAN_ADDR);
    if(alw.lt(fee)){
      const ov1 = await buildSafeOverrides(vin, "approve", [MUABAN_ADDR, fee], provider, account);
      const tx1 = await vin.approve(MUABAN_ADDR, fee, ov1);
      uiToast(`Approve phí đăng ký… <a href="${explorerTx(tx1.hash)}" target="_blank" rel="noopener">tx</a>`, "info", 6000);
      await tx1.wait();
    }

    const ov2 = await buildSafeOverrides(muaban, "payRegistration", [], provider, account);
    const tx2 = await muaban.payRegistration(ov2);
    uiToast(`Gửi phí đăng ký… <a href="${explorerTx(tx2.hash)}" target="_blank" rel="noopener">tx</a>`, "info", 6000);
    await tx2.wait();
    uiToast("Đăng ký ví thành công.", "success");
    return true;
  }

  // ---------------------- Product list ----------------------
  let PRODUCTS = [];

  async function loadProducts(focusPid=null){
    $productList.innerHTML = "";
    PRODUCTS = [];

    if(focusPid && Number.isFinite(focusPid) && focusPid>0){
      try{
        const p = await muaban.getProduct(focusPid);
        if(p && p.seller && p.seller !== ethers.constants.AddressZero){
          PRODUCTS.push({ pid: focusPid, p, unit: "(đv)" });
        }
      }catch(_){/* ignore */}
    }

    let emptyStreak = 0;
    for(let pid=1; pid<=MAX_SCAN; pid++){
      if(focusPid && pid===focusPid) continue;
      try{
        const p = await muaban.getProduct(pid);
        if(!p || !p.seller || p.seller === ethers.constants.AddressZero){
          emptyStreak++;
          if(emptyStreak >= MAX_EMPTY_STREAK) break;
          continue;
        }
        emptyStreak = 0;
        PRODUCTS.push({ pid, p, unit: "(đv)" });
      }catch(_){
        emptyStreak++;
        if(emptyStreak >= MAX_EMPTY_STREAK) break;
      }
    }

    PRODUCTS.sort((a,b)=> b.pid - a.pid);
    renderProducts(PRODUCTS);
  }

  // ---- Seller modal (hiển thị rõ người bán) ----
  let sellerModal;
  function ensureSellerModal(){
    if(sellerModal) return sellerModal;
    sellerModal = document.createElement("div");
    sellerModal.className = "modal hidden";
    sellerModal.innerHTML = `
      <div class="modal-content" style="max-width:560px">
        <div class="modal-header">
          <h3>Thông tin người bán</h3>
          <button class="btn close">Đóng</button>
        </div>
        <div class="modal-body" id="sellerBody"></div>
      </div>`;
    document.body.appendChild(sellerModal);
    sellerModal.addEventListener("click", (e)=>{ if(e.target.classList.contains("modal")) closeModal(sellerModal); });
    sellerModal.querySelector(".btn.close").addEventListener("click", ()=> closeModal(sellerModal));
    return sellerModal;
  }
  function openSellerModal(p){
    const m = ensureSellerModal();
    const $body = m.querySelector("#sellerBody");
    const seller = p.seller;
    const payout = p.payoutWallet;
    $body.innerHTML = `
      <div class="info-row">Ví seller:<br><a class="mono" href="${VIC.EXPLORER}/address/${seller}" target="_blank" rel="noopener">${seller}</a></div>
      <div class="info-row" style="margin-top:8px">Ví nhận tiền (payout):<br><a class="mono" href="${VIC.EXPLORER}/address/${payout}" target="_blank" rel="noopener">${payout}</a></div>
      <div class="info-row" style="margin-top:8px;color:#475569;font-size:13px;">Tiền chỉ được chuyển cho người bán khi người mua xác nhận <b>đã nhận hàng</b> (escrow).</div>
    `;
    openModal(m);
  }

  function renderProducts(list){
    const q = ($searchInput.value||"").trim().toLowerCase();
    const filtered = q ? list.filter(x => (x.p?.name||"").toLowerCase().includes(q)) : list;

    if(filtered.length===0){
      $productList.innerHTML = `<div class="product-card" style="grid-column:span 12;">Không có sản phẩm.</div>`;
      return;
    }

    $productList.innerHTML = filtered.map(({pid,p})=>{
      const img = p.imageCID ? toHttpIPFS(p.imageCID) : "";
      const stockBadge = p.active ? `<span class="stock-badge">Còn hàng</span>` : `<span class="stock-badge out">Hết hàng</span>`;
      const priceInt = (p.priceVND && p.priceVND.toString) ? parseInt(p.priceVND.toString(),10) : Number(p.priceVND||0);
      const priceHtml = `<span class="price-vnd">${fmtVND(priceInt)} VND</span>`;
      const isSeller = account && (account.toLowerCase() === p.seller.toLowerCase());
      const canBuy   = !!account && !isSeller && p.active;

      const sellerBlock = `
        <div class="seller-meta">
          Người bán: <span class="mono">${short(p.seller)}</span>
          · Payout: <span class="mono">${short(p.payoutWallet)}</span>
          <button class="btn small" data-act="seller" data-pid="${pid}">Xem</button>
          <a class="btn small" href="${VIC.EXPLORER}/address/${p.seller}" target="_blank" rel="noopener">VicScan</a>
        </div>`;

      const actions = [
        canBuy ? `<button class="btn primary" data-act="buy" data-pid="${pid}">Mua</button>` : "",
        isSeller ? `<button class="btn" data-act="update" data-pid="${pid}">Cập nhật</button>` : ""
      ].filter(Boolean).join(" ");

      return `
      <div class="product-card" data-pid="${pid}">
        <img class="product-thumb" src="${img||'https://ipfs.io/ipfs/'}" alt="">
        <div class="product-info">
          <div class="product-top">
            <h3 class="product-title">${escapeHtml(p.name||"")}</h3>
            ${stockBadge}
          </div>
          <div class="product-meta">
            ${priceHtml}
          </div>
          ${sellerBlock}
          <div class="card-actions">
            ${actions}
          </div>
        </div>
      </div>`;
    }).join("");

    $productList.querySelectorAll("[data-act='buy']").forEach(btn=> btn.addEventListener("click", ()=> openBuyModal(Number(btn.dataset.pid))));
    $productList.querySelectorAll("[data-act='update']").forEach(btn=> btn.addEventListener("click", ()=> openUpdateModal(Number(btn.dataset.pid))));
    $productList.querySelectorAll("[data-act='seller']").forEach(btn=> btn.addEventListener("click", ()=> {
      const pid = Number(btn.dataset.pid);
      const item = PRODUCTS.find(x=>x.pid===pid);
      if(item) openSellerModal(item.p);
    }));
  }

  // ---------------------- Create / Update product ----------------------
  function openCreateModal(){ openModal($formCreate); }

  async function submitCreate(){
    try{
      // Đảm bảo đã có ví + đúng mạng trước khi làm gì
      if(!account) await connect();
      const ok = await ensureViction();
      if(!ok) return;

      await fetchPrices();
      if(!vndPerVIN_INT || !vinPerVNDWei) throw new Error("Chưa có tỷ giá. Hãy thử lại.");

      // BẮT BUỘC đăng ký trước (sẽ bật ký ví đúng lúc)
      await ensureRegisteredFlow();

      const name  = ($createName.value||"").trim();
      const ipfs  = ($createIPFS.value||"").trim();
      const unit  = ($createUnit.value||"").trim(); // client-only
      let priceIn = Number($createPrice.value||0);
      const days  = parseInt($createDays.value, 10);
      const wallet= ($createWallet.value||"").trim();

      if(!name) throw new Error("Vui lòng nhập Tên sản phẩm.");
      if(!Number.isFinite(priceIn) || priceIn<=0) throw new Error("Giá bán (VND) phải là số dương.");
      if(!(days>0)) throw new Error("Số ngày giao hàng phải > 0.");
      if(!ethers.utils.isAddress(wallet)) throw new Error("Ví nhận không hợp lệ.");

      priceIn = Math.floor(priceIn); // ✅ VND là số nguyên

      const descriptionCID = "";
      const imageCID = ipfs;
      const priceVND = ethers.BigNumber.from(priceIn.toString());
      const deliveryDaysMax = days >>> 0;
      const payoutWallet = wallet;
      const active = true;

      // KHÔNG dùng callStatic để tránh báo lỗi trước khi ký
      // Thay vào đó: gửi trực tiếp với overrides an toàn
      const overrides = await buildSafeOverrides(
        muaban, "createProduct",
        [name, descriptionCID, imageCID, priceVND, deliveryDaysMax, payoutWallet, active],
        provider, account
      );

      $btnSubmitCreate.disabled = true;
      $btnSubmitCreate.textContent = "Đang gửi giao dịch…";
      uiToast("Đang gửi giao dịch tạo sản phẩm… Vui lòng ký trong MetaMask.", "info", 5500);

      // Thử lấy pid dự kiến sau khi mined bằng event (ở đây chỉ reload list, không cần pid)
      const tx = await muaban.createProduct(
        name, descriptionCID, imageCID, priceVND, deliveryDaysMax, payoutWallet, active, overrides
      );
      uiToast(`Đã gửi TX: <a href="${explorerTx(tx.hash)}" target="_blank" rel="noopener">xem VicScan</a>`, "info", 6500);

      const rc = await tx.wait();
      if(!rc || rc.status !== 1) throw new Error("Giao dịch bị revert.");

      uiToast("Tạo sản phẩm THÀNH CÔNG.", "success");

      closeModal($formCreate);
      $createName.value = ""; $createIPFS.value = ""; $createUnit.value = ""; $createPrice.value = "";
      $createWallet.value = ""; $createDays.value = "7";

      await loadProducts();
      // highlight card mới nhất
      const first = document.querySelector('.product-card');
      if(first){ first.classList.add('pulse-new'); setTimeout(()=>first.classList.remove('pulse-new'), 3000); first.scrollIntoView({behavior:'smooth', block:'center'}); }
    }catch(err){
      console.error("[submitCreate error]", err);
      uiToast(prettifyError(err), "error", 9000);
    }finally{
      $btnSubmitCreate.disabled = false;
      $btnSubmitCreate.textContent = "Đăng sản phẩm";
    }
  }

  async function openUpdateModal(pid){
    try{
      const p = await muaban.getProduct(pid);
      if(!p || p.seller.toLowerCase() !== account.toLowerCase()){
        return uiToast("Bạn không phải seller của sản phẩm này.", "warn");
      }
      $updatePid.value = String(pid);
      $updatePrice.value = String(p.priceVND || 0);
      $updateDays.value = String(p.deliveryDaysMax || 1);
      $updateWallet.value = p.payoutWallet || "";
      $updateActive.checked = !!p.active;
      openModal($formUpdate);
    }catch(err){ uiToast(`Không mở được form cập nhật: ${prettifyError(err)}`, "error", 7000); }
  }

  async function submitUpdate(){
    try{
      await ensureRegisteredFlow();
      let price = Math.floor(Number($updatePrice.value||0));
      const pid   = parseInt($updatePid.value, 10);
      const days  = parseInt($updateDays.value,10)>>>0;
      const wallet= ($updateWallet.value||"").trim();
      const active= !!$updateActive.checked;

      if(!(pid>0)) throw new Error("PID không hợp lệ.");
      if(!(price>0)) throw new Error("Giá phải > 0.");
      if(!(days>0)) throw new Error("Số ngày phải > 0.");
      if(!ethers.utils.isAddress(wallet)) throw new Error("Ví nhận không hợp lệ.");

      const priceVND = ethers.BigNumber.from(price.toString());

      const overrides = await buildSafeOverrides(muaban, "updateProduct", [pid, priceVND, days, wallet, active], provider, account);
      const tx = await muaban.updateProduct(pid, priceVND, days, wallet, active, overrides);
      uiToast(`Đang cập nhật… <a href="${explorerTx(tx.hash)}" target="_blank" rel="noopener">tx</a>`, "info", 6000);
      await tx.wait();
      closeModal($formUpdate);
      await loadProducts(pid);
      uiToast("Cập nhật sản phẩm thành công.", "success");
    }catch(err){ uiToast(prettifyError(err), "error", 8000); }
  }

  // ---------------------- Buy product ----------------------
  let BUYING_PID = null;
  let BUYING_PRODUCT = null;

  async function openBuyModal(pid){
    try{
      const p = await muaban.getProduct(pid);
      if(!p || !p.active) return uiToast("Sản phẩm không còn bán.", "warn");
      BUYING_PID = pid; BUYING_PRODUCT = p;
      const img = p.imageCID ? toHttpIPFS(p.imageCID) : "";
      $buyProductInfo.innerHTML = `
        <div><b>${escapeHtml(p.name||"")}</b></div>
        <div>Giá: <span class="order-strong">${fmtVND(parseInt(p.priceVND.toString(),10))} VNĐ</span></div>
        <div>Người bán: <span class="mono">${short(p.seller)}</span> · Payout: <span class="mono">${short(p.payoutWallet)}</span></div>
        ${img ? `<div><img src="${img}" style="width:100%;max-height:220px;object-fit:cover;border-radius:8px;border:1px solid #eef1f5;" /></div>` : ""}
      `;
      $buyName.value = ""; $buyAddress.value = ""; $buyPhone.value = ""; $buyNote.value = ""; $buyQty.value = "1";
      await updateBuyTotal();
      openModal($formBuy);
    }catch(err){ uiToast(prettifyError(err), "error", 7000); }
  }

  async function updateBuyTotal(){
    try{
      if(!vndPerVIN_INT) await fetchPrices();
      const qty = Math.max(1, parseInt($buyQty.value,10)||1);
      const priceVND = BUYING_PRODUCT ? parseInt(BUYING_PRODUCT.priceVND.toString(),10) : 0;
      const totalVND = priceVND * qty;
      if(vndPerVIN_INT>0){
        const vinAmount = totalVND / vndPerVIN_INT; // ước tính hiển thị
        $buyTotalVIN.textContent = `Tổng VIN cần trả (ước tính): ${vinAmount.toFixed(6)} VIN`;
      }else{ $buyTotalVIN.textContent = `Tổng VIN cần trả: (đang tải giá)`; }
    }catch(_){/* noop */}
  }

  async function submitBuy(){
    try{
      await ensureRegisteredFlow();
      await fetchPrices();
      if(!vinPerVNDWei) throw new Error("Chưa có tỷ giá.");

      const qty = Math.max(1, parseInt($buyQty.value,10)||1);
      if(!(qty>0)) throw new Error("Số lượng phải > 0.");

      const payload = JSON.stringify({
        name: ($buyName.value||"").trim(),
        address: ($buyAddress.value||"").trim(),
        phone: ($buyPhone.value||"").trim(),
        note: ($buyNote.value||"").trim()
      });
      const buyerInfoCipher = btoa(unescape(encodeURIComponent(payload)));

      const priceVND = ethers.BigNumber.from(parseInt(BUYING_PRODUCT.priceVND.toString(),10).toString());
      const totalVND = priceVND.mul(qty.toString());
      const one = ethers.utils.parseUnits("1", vinDecimals);
      const estVIN = totalVND.mul(vinPerVNDWei).add(one.sub(1)).div(one); // ceil

      const allowance = await vin.allowance(account, MUABAN_ADDR);
      if(allowance.lt(estVIN)){
        const ov1 = await buildSafeOverrides(vin, "approve", [MUABAN_ADDR, estVIN], provider, account);
        const tx1 = await vin.approve(MUABAN_ADDR, estVIN, ov1);
        uiToast(`Approve ~${fmtVIN(estVIN)} VIN… <a href="${explorerTx(tx1.hash)}" target="_blank" rel="noopener">tx</a>`, "info", 6000);
        await tx1.wait();
      }

      const overrides = await buildSafeOverrides(muaban, "placeOrder", [BUYING_PID, ethers.BigNumber.from(qty.toString()), vinPerVNDWei, buyerInfoCipher], provider, account);
      const tx2 = await muaban.placeOrder(BUYING_PID, ethers.BigNumber.from(qty.toString()), vinPerVNDWei, buyerInfoCipher, overrides);
      uiToast(`Đặt hàng… <a href="${explorerTx(tx2.hash)}" target="_blank" rel="noopener">tx</a>`, "info", 6000);
      await tx2.wait();
      uiToast("Đặt hàng thành công. VIN đã ký quỹ trong hợp đồng.", "success");
      closeModal($formBuy);
    }catch(err){ uiToast(prettifyError(err), "error", 8000); }
  }

  // ---------------------- Search ----------------------
  function doSearch(){ renderProducts(PRODUCTS); }

  // ---------------------- Modals ----------------------
  function openModal($el){ if(!$el) return; $el.classList.remove("hidden"); document.body.classList.add("no-scroll"); $el.addEventListener("click", backdropCloser); $el.querySelectorAll(".btn.close").forEach(b=>b.addEventListener("click", ()=> closeModal($el))); }
  function closeModal($el){ if(!$el) return; $el.classList.add("hidden"); document.body.classList.remove("no-scroll"); $el.removeEventListener("click", backdropCloser); }
  function backdropCloser(e){ if(e.target.classList.contains("modal")) closeModal(e.currentTarget); }

  // ---------------------- Init ----------------------
  async function init(){
    await fetchPrices();
    setInterval(fetchPrices, 60000);

    if(window.ethereum){
      provider = new ethers.providers.Web3Provider(window.ethereum, "any");
      try{
        const accs = await provider.listAccounts();
        const chainId = await window.ethereum.request({ method: "eth_chainId" });
        if(accs?.length && chainId === VIC.CHAIN_ID_HEX){
          signer = provider.getSigner();
          account = await signer.getAddress();
          await initContracts();
          await refreshWalletUI();
          await afterConnectedUI();
        }
      }catch(_){/* ignore */}
    }

    $btnConnect?.addEventListener("click", ()=> connect());
    $btnDisconnect?.addEventListener("click", ()=> disconnect());

    $btnRegister?.addEventListener("click", ()=> ensureRegisteredFlow());
    $btnCreate?.addEventListener("click", ()=> openCreateModal());
    $btnSubmitCreate?.addEventListener("click", ()=> submitCreate());

    $btnSubmitUpdate?.addEventListener("click", ()=> submitUpdate());

    $btnSearch?.addEventListener("click", ()=> doSearch());
    $searchInput?.addEventListener("keydown", (e)=>{ if(e.key==="Enter") doSearch(); });

    $buyQty?.addEventListener("input", ()=> updateBuyTotal());
    $btnSubmitBuy?.addEventListener("click", ()=> submitBuy());
  }

  document.addEventListener("DOMContentLoaded", init);
})();
