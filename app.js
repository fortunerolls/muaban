/* ==========================================================================
   muaban.vin — app.js (ethers v5)
   Khớp index.html + style.css hiện tại
   Triệt tiêu "Internal JSON-RPC error" bằng quy trình approve chuẩn + ép kiểu
   ========================================================================== */

(() => {
  // ---------------------- Constants ----------------------
  const VIC = {
    CHAIN_ID_DEC: 88,
    CHAIN_ID_HEX: "0x58",
    RPC_URL: "https://rpc.viction.xyz",
    EXPLORER: "https://www.vicscan.xyz",
    NAME: "Viction Mainnet",
    CURRENCY: { name: "VIC", symbol: "VIC", decimals: 18 }
  };

  // Hợp đồng (VIC)
  const MUABAN_ADDR = "0x190FD18820498872354eED9C4C080cB365Cd12E0"; // contract
  const VIN_ADDR    = "0x941F63807401efCE8afe3C9d88d368bAA287Fac4"; // VIN token

  // Endpoints giá
  const BINANCE_VICUSDT = "https://api.binance.com/api/v3/ticker/price?symbol=VICUSDT";
  const COINGECKO_USDT_VND = "https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=vnd";

  // Quét danh sách sản phẩm
  const MAX_SCAN = 200;              // tối đa ID sản phẩm cần quét
  const MAX_EMPTY_STREAK = 20;       // gặp chuỗi rỗng liên tiếp thì dừng

  // ---------------------- Minimal ABIs ----------------------
  // ERC20 (VIN)
  const ERC20_ABI = [
    "function decimals() view returns (uint8)",
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function approve(address spender, uint256 value) returns (bool)"
  ];

  // MuabanVND (rút gọn theo ABI bạn gửi)
  const MUABAN_ABI = [
    "function REG_FEE() view returns (uint256)",
    "function vin() view returns (address)",
    "function registered(address) view returns (bool)",

    "function payRegistration() external",
    "function createProduct(string name,string descriptionCID,string imageCID,uint256 priceVND,uint32 deliveryDaysMax,address payoutWallet,bool active) external returns (uint256 pid)",
    "function updateProduct(uint256 pid,uint256 priceVND,uint32 deliveryDaysMax,address payoutWallet,bool active) external",
    "function setProductActive(uint256 pid,bool active) external",

    "function getSellerProductIds(address seller) view returns (uint256[] memory)",
    "function getProduct(uint256 pid) view returns (tuple(uint256 productId,address seller,string name,string descriptionCID,string imageCID,uint256 priceVND,uint32 deliveryDaysMax,address payoutWallet,bool active,uint64 createdAt,uint64 updatedAt))",

    "function placeOrder(uint256 productId,uint256 quantity,uint256 vinPerVND,string buyerInfoCipher) external returns (uint256 oid)",
    "function getOrder(uint256 oid) view returns (tuple(uint256 orderId,uint256 productId,address buyer,address seller,uint256 quantity,uint256 vinAmount,uint256 placedAt,uint256 deadline,uint8 status,string buyerInfoCipher))",
    "function confirmReceipt(uint256 orderId) external",
    "function refundIfExpired(uint256 orderId) external"
  ];

  // ---------------------- State ----------------------
  let provider;        // ethers.providers.Web3Provider
  let signer;          // ethers.Signer
  let account;         // string
  let muaban;          // ethers.Contract
  let vin;             // ethers.Contract
  let vinDecimals = 18;

  // Giá
  let priceVIC_USDT = null; // number
  let priceUSDT_VND = null; // number
  let vndPerVIN = null;     // number (VND cho 1 VIN)
  let vinPerVNDWei = null;  // BigNumber string (wei VIN cho 1 VND)

  // UI refs
  const $ = (id) => document.getElementById(id);
  const $vinPrice = $("vinPrice");
  const $btnConnect = $("btnConnect");
  const $btnDisconnect = $("btnDisconnect");
  const $walletBox = $("walletBox");
  const $vinBalance = $("vinBalance");
  const $vicBalance = $("vicBalance");
  const $accountShort = $("accountShort");

  const $menuBox = $("menuBox");
  const $btnRegister = $("btnRegister");
  const $btnCreate = $("btnCreate");
  const $btnOrdersBuy = $("btnOrdersBuy");
  const $btnOrdersSell = $("btnOrdersSell");

  const $searchInput = $("searchInput");
  const $btnSearch = $("btnSearch");
  const $productList = $("productList");

  // Modals
  const $formCreate = $("formCreate");
  const $formUpdate = $("formUpdate");
  const $formBuy    = $("formBuy");

  // Create fields
  const $createName   = $("createName");
  const $createIPFS   = $("createIPFS");
  const $createUnit   = $("createUnit"); // giữ client-side (hợp đồng không có)
  const $createPrice  = $("createPrice");
  const $createWallet = $("createWallet");
  const $createDays   = $("createDays");
  const $btnSubmitCreate = $("btnSubmitCreate");

  // Update fields
  const $updatePid   = $("updatePid");
  const $updatePrice = $("updatePrice");
  const $updateDays  = $("updateDays");
  const $updateWallet= $("updateWallet");
  const $updateActive= $("updateActive");
  const $btnSubmitUpdate = $("btnSubmitUpdate");

  // Buy fields
  const $buyProductInfo = $("buyProductInfo");
  const $buyName    = $("buyName");
  const $buyAddress = $("buyAddress");
  const $buyPhone   = $("buyPhone");
  const $buyNote    = $("buyNote");
  const $buyQty     = $("buyQty");
  const $buyTotalVIN= $("buyTotalVIN");
  const $btnSubmitBuy = $("btnSubmitBuy");

  // Helpers
  const short = (addr) => addr ? (addr.slice(0,6)+"…"+addr.slice(-4)) : "";
  const fmtVND = (n) => Number(n||0).toLocaleString("vi-VN");
  const fmtVIN = (wei) => {
    try{ return ethers.utils.formatUnits(wei, vinDecimals); }catch(_){ return "0"; }
  };

  function toast(msg, type="info"){
    console[type === "warn" ? "warn" : (type === "error" ? "error" : "log")]("[muaban]", msg);
    // Có thể gắn UI toast nếu muốn
  }

  // ---------------------- Chain / Provider ----------------------
  async function ensureViction(){
    if(!window.ethereum) { toast("No wallet found.","warn"); return false; }
    const eth = window.ethereum;
    const chainId = await eth.request({ method: "eth_chainId" });
    if (chainId === VIC.CHAIN_ID_HEX) return true;

    try{
      await eth.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: VIC.CHAIN_ID_HEX }]
      });
      return true;
    }catch(err){
      if (err && err.code === 4902){
        // Add chain
        await eth.request({
          method: "wallet_addEthereumChain",
          params: [{
            chainId: VIC.CHAIN_ID_HEX,
            chainName: VIC.NAME,
            nativeCurrency: VIC.CURRENCY,
            rpcUrls: [VIC.RPC_URL],
            blockExplorerUrls: [VIC.EXPLORER]
          }]
        });
        return true;
      }
      toast(`Switch chain failed: ${err?.message||err}`, "error");
      return false;
    }
  }

  async function connect(){
    if(!window.ethereum) return toast("No wallet found.","warn");
    try{
      provider = new ethers.providers.Web3Provider(window.ethereum, "any");
      await provider.send("eth_requestAccounts", []);
      const ok = await ensureViction();
      if(!ok) return toast("Please switch to Viction.","warn");
      signer = provider.getSigner();
      account = await signer.getAddress();

      await initContracts();
      await refreshWalletUI();
      await afterConnectedUI();

      // Events
      window.ethereum?.on?.("accountsChanged", ()=> location.reload());
      window.ethereum?.on?.("chainChanged", ()=> location.reload());
    }catch(err){
      toast(`Connect error: ${err?.message||err}`,"error");
    }
  }

  async function initContracts(){
    vin = new ethers.Contract(VIN_ADDR, ERC20_ABI, signer);
    const d = await vin.decimals();
    vinDecimals = Number(d||18);

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
    }catch(err){
      toast(`Balance error: ${err?.message||err}`,"error");
    }
  }

  async function afterConnectedUI(){
    try{
      const isReg = await muaban.registered(account);
      $menuBox.classList.remove("hidden");
      if(!isReg){
        // Chỉ hiện Đăng ký
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

      // Sau khi có ví → load sản phẩm
      await loadProducts();
    }catch(err){
      toast(`UI init error: ${err?.message||err}`,"error");
    }
  }

  function disconnect(){
    // MetaMask không có API ngắt kết nối; ta chỉ reset UI
    account = null;
    signer = null;
    provider = null;
    location.reload();
  }

  // ---------------------- Pricing ----------------------
  async function fetchPrices(){
    try{
      // VIC/USDT
      const b = await fetch(BINANCE_VICUSDT, { cache: "no-store" }).then(r=>r.json());
      priceVIC_USDT = Number(b?.price || 0);
      if(!(priceVIC_USDT>0)) throw new Error("VIC/USDT not available");

      // USDT→VND (CoinGecko)
      const c = await fetch(COINGECKO_USDT_VND, { cache: "no-store" }).then(r=>r.json());
      priceUSDT_VND = Number(c?.tether?.vnd || 0);
      if(!(priceUSDT_VND>0)) throw new Error("USDT/VND not available");

      // 1 VIN = (VIC/USDT * 100) * (USDT/VND)
      vndPerVIN = priceVIC_USDT * 100 * priceUSDT_VND;

      // vinPerVND (wei per 1 VND) = floor(1e18 / vndPerVIN)
      if(vndPerVIN>0){
        vinPerVNDWei = ethers.utils.parseUnits("1", vinDecimals).div(ethers.BigNumber.from(Math.ceil(vndPerVIN).toString()));
      }else{
        vinPerVNDWei = null;
      }

      $vinPrice.textContent = vndPerVIN>0 ? `1 VIN = ${vndPerVIN.toLocaleString("vi-VN")} VND` : "Loading price...";
    }catch(err){
      $vinPrice.textContent = "Loading price...";
      toast(`Price fetch error: ${err?.message||err}`,"warn");
    }
  }

  // ---------------------- Product rendering ----------------------
  let PRODUCTS = []; // cache {pid, data, unit?}

  async function loadProducts(){
    $productList.innerHTML = "";
    PRODUCTS = [];

    // Quét ID 1..MAX_SCAN, dừng sớm khi chuỗi rỗng dài
    let emptyStreak = 0;
    for(let pid=1; pid<=MAX_SCAN; pid++){
      try{
        const p = await muaban.getProduct(pid);
        if(!p || !p.seller || p.seller === ethers.constants.AddressZero){
          emptyStreak++;
          if(emptyStreak >= MAX_EMPTY_STREAK) break;
          continue;
        }
        emptyStreak = 0;
        PRODUCTS.push({ pid, p, unit: "(đv)" }); // unit chỉ client-side vì hợp đồng không lưu
      }catch(_){
        emptyStreak++;
        if(emptyStreak >= MAX_EMPTY_STREAK) break;
      }
    }

    // Render
    renderProducts(PRODUCTS);
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
      const unitHtml = `<span class="unit">${" " + (/*unit*/ "" || "")}</span>`;
      const stockBadge = p.active ? `<span class="stock-badge">Còn hàng</span>` : `<span class="stock-badge out">Hết hàng</span>`;
      const priceHtml = `<span class="price-vnd">${fmtVND(p.priceVND)} VND</span>${unitHtml}`;

      const isSeller = account && (account.toLowerCase() === p.seller.toLowerCase());
      const canBuy   = !!account && !isSeller && p.active;

      const actions = [
        canBuy ? `<button class="btn primary" data-act="buy" data-pid="${pid}">Mua</button>` : "",
        isSeller ? `<button class="btn" data-act="update" data-pid="${pid}">Cập nhật sản phẩm</button>` : ""
      ].filter(Boolean).join(" ");

      return `
      <div class="product-card">
        <img class="product-thumb" src="${img||'https://ipfs.io/ipfs/'}" alt="">
        <div class="product-info">
          <div class="product-top">
            <h3 class="product-title">${escapeHtml(p.name||"")}</h3>
            ${stockBadge}
          </div>
          <div class="product-meta">
            ${priceHtml} · Người bán: <span class="mono">${short(p.seller)}</span>
          </div>
          <div class="card-actions">
            ${actions}
            <a class="btn small" href="${VIC.EXPLORER}/address/${p.seller}" target="_blank" rel="noopener">Ví người bán</a>
          </div>
        </div>
      </div>`;
    }).join("");

    // Bind actions
    $productList.querySelectorAll("[data-act='buy']").forEach(btn=>{
      btn.addEventListener("click", ()=>{
        const pid = Number(btn.dataset.pid);
        openBuyModal(pid);
      });
    });
    $productList.querySelectorAll("[data-act='update']").forEach(btn=>{
      btn.addEventListener("click", ()=>{
        const pid = Number(btn.dataset.pid);
        openUpdateModal(pid);
      });
    });
  }

  function toHttpIPFS(link){
    if(!link) return "";
    if(link.startsWith("ipfs://")) return `https://ipfs.io/ipfs/${link.replace("ipfs://","")}`;
    return link;
  }

  function escapeHtml(s){
    return String(s).replace(/[&<>"']/g, (m)=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[m]));
  }

  // ---------------------- Registration ----------------------
  async function ensureRegisteredFlow(){
    if(!account) { await connect(); }
    const isReg = await muaban.registered(account);
    if(isReg) return true;

    // Lấy REG_FEE
    const fee = await muaban.REG_FEE();

    // Approve cho contract
    const allowance = await vin.allowance(account, MUABAN_ADDR);
    if(allowance.lt(fee)){
      const tx1 = await vin.approve(MUABAN_ADDR, fee);
      await tx1.wait();
    }

    const tx2 = await muaban.payRegistration();
    await tx2.wait();

    toast("Đăng ký ví thành công.");
    return true;
  }

  // ---------------------- Create Product ----------------------
  function openCreateModal(){
    openModal($formCreate);
  }

  async function submitCreate(){
    try{
      await ensureRegisteredFlow();
      // Thu thập dữ liệu
      const name  = ($createName.value||"").trim();
      const ipfs  = ($createIPFS.value||"").trim();
      const unit  = ($createUnit.value||"").trim(); // chỉ để hiển thị client-side
      const price = parseInt($createPrice.value, 10);
      const days  = parseInt($createDays.value, 10);
      const wallet= ($createWallet.value||"").trim();

      if(!name) throw new Error("Vui lòng nhập tên.");
      if(!(price>0)) throw new Error("Giá bán phải > 0.");
      if(!(days>0)) throw new Error("Số ngày giao hàng phải > 0.");
      if(!ethers.utils.isAddress(wallet)) throw new Error("Ví nhận không hợp lệ.");

      // Map vào tham số hợp đồng
      const descriptionCID = "";           // UI hiện tại không có field mô tả tách biệt
      const imageCID = ipfs;               // Link IPFS ảnh/video
      const priceVND = ethers.BigNumber.from(price.toString());
      const deliveryDaysMax = days >>> 0;  // to uint32
      const payoutWallet = wallet;
      const active = true;

      const tx = await muaban.createProduct(
        name,
        descriptionCID,
        imageCID,
        priceVND,
        deliveryDaysMax,
        payoutWallet,
        active
      );
      await tx.wait();

      closeModal($formCreate);
      await loadProducts();
      toast("Đăng sản phẩm thành công.");
    }catch(err){
      toast(`Create error: ${err?.message||err}`,"error");
    }
  }

  // ---------------------- Update Product ----------------------
  async function openUpdateModal(pid){
    try{
      const p = await muaban.getProduct(pid);
      if(!p || p.seller.toLowerCase() !== account.toLowerCase()){
        return toast("Bạn không phải seller của sản phẩm này.","warn");
      }
      $updatePid.value = String(pid);
      $updatePrice.value = String(p.priceVND || 0);
      $updateDays.value = String(p.deliveryDaysMax || 1);
      $updateWallet.value = p.payoutWallet || "";
      $updateActive.checked = !!p.active;

      openModal($formUpdate);
    }catch(err){
      toast(`Open update error: ${err?.message||err}`,"error");
    }
  }

  async function submitUpdate(){
    try{
      await ensureRegisteredFlow();
      const pid   = parseInt($updatePid.value, 10);
      const price = ethers.BigNumber.from((parseInt($updatePrice.value,10)||0).toString());
      const days  = parseInt($updateDays.value,10)>>>0;
      const wallet= ($updateWallet.value||"").trim();
      const active= !!$updateActive.checked;

      if(!(pid>0)) throw new Error("PID không hợp lệ.");
      if(price.lte(0)) throw new Error("Giá phải > 0.");
      if(!(days>0)) throw new Error("Số ngày phải > 0.");
      if(!ethers.utils.isAddress(wallet)) throw new Error("Ví nhận không hợp lệ.");

      const tx = await muaban.updateProduct(pid, price, days, wallet, active);
      await tx.wait();

      closeModal($formUpdate);
      await loadProducts();
      toast("Cập nhật sản phẩm thành công.");
    }catch(err){
      toast(`Update error: ${err?.message||err}`,"error");
    }
  }

  // ---------------------- Buy Product ----------------------
  let BUYING_PID = null;
  let BUYING_PRODUCT = null;

  async function openBuyModal(pid){
    try{
      await ensureRegisteredFlow();
      const p = await muaban.getProduct(pid);
      if(!p || !p.active) return toast("Sản phẩm không còn bán.","warn");

      BUYING_PID = pid;
      BUYING_PRODUCT = p;

      const img = p.imageCID ? toHttpIPFS(p.imageCID) : "";
      $buyProductInfo.innerHTML = `
        <div><b>${escapeHtml(p.name||"")}</b></div>
        <div>Giá: <span class="order-strong">${fmtVND(p.priceVND)} VNĐ</span></div>
        <div>Người bán: <span class="mono">${short(p.seller)}</span></div>
        ${img ? `<div><img src="${img}" style="width:100%;max-height:220px;object-fit:cover;border-radius:8px;border:1px solid #eef1f5;" /></div>` : ""}
      `;

      // reset form
      $buyName.value = "";
      $buyAddress.value = "";
      $buyPhone.value = "";
      $buyNote.value = "";
      $buyQty.value = "1";

      await updateBuyTotal(); // cần giá
      openModal($formBuy);
    }catch(err){
      toast(`Open buy error: ${err?.message||err}`,"error");
    }
  }

  async function updateBuyTotal(){
    try{
      // Đảm bảo đã có giá
      if(!vndPerVIN) await fetchPrices();
      const qty = Math.max(1, parseInt($buyQty.value,10)||1);
      const totalVND = (BUYING_PRODUCT?.priceVND || 0) * qty;

      if(vndPerVIN>0){
        const vinAmount = totalVND / vndPerVIN; // số VIN (float)
        $buyTotalVIN.textContent = `Tổng VIN cần trả: ${vinAmount.toFixed(6)} VIN`;
      }else{
        $buyTotalVIN.textContent = `Tổng VIN cần trả: (đang tải giá)`;
      }
    }catch(_){}
  }

  async function submitBuy(){
    try{
      await ensureRegisteredFlow();

      const qty = Math.max(1, parseInt($buyQty.value,10)||1);
      if(!(qty>0)) throw new Error("Số lượng phải > 0.");

      // Buyer info → mã hóa đơn giản (base64). Có thể nâng cấp RSA/ECIES.
      const payload = JSON.stringify({
        name: ($buyName.value||"").trim(),
        address: ($buyAddress.value||"").trim(),
        phone: ($buyPhone.value||"").trim(),
        note: ($buyNote.value||"").trim()
      });
      const buyerInfoCipher = btoa(unescape(encodeURIComponent(payload)));

      // Đảm bảo giá đã sẵn sàng
      await fetchPrices();
      if(!vinPerVNDWei) throw new Error("Chưa có tỷ giá.");

      // Tính tổng VIN chính xác theo công thức hợp đồng (ceil chia ở contract)
      // Ở đây cần ước tính để approve: totalVIN_est = ceil(totalVND * vinPerVNDWei / 1e18)
      const totalVND = ethers.BigNumber.from((BUYING_PRODUCT.priceVND || 0).toString()).mul(qty.toString());
      const one = ethers.utils.parseUnits("1", vinDecimals);
      const estVIN = totalVND.mul(vinPerVNDWei).add(one.sub(1)).div(one); // ceil

      // Approve đủ VIN cho contract
      const allowance = await vin.allowance(account, MUABAN_ADDR);
      if(allowance.lt(estVIN)){
        const tx1 = await vin.approve(MUABAN_ADDR, estVIN);
        await tx1.wait();
      }

      // placeOrder(productId, quantity, vinPerVND, buyerInfoCipher)
      const tx2 = await muaban.placeOrder(
        BUYING_PID,
        ethers.BigNumber.from(qty.toString()),
        vinPerVNDWei,   // wei VIN per 1 VND
        buyerInfoCipher
      );
      await tx2.wait();

      closeModal($formBuy);
      toast("Đặt hàng thành công. VIN đã ký quỹ trong hợp đồng.");
    }catch(err){
      toast(`Buy error: ${err?.message||err}`,"error");
    }
  }

  // ---------------------- Search ----------------------
  function doSearch(){
    renderProducts(PRODUCTS);
  }

  // ---------------------- Modals ----------------------
  function openModal($el){
    if(!$el) return;
    $el.classList.remove("hidden");
    document.body.classList.add("no-scroll");
    $el.addEventListener("click", backdropCloser);
    $el.querySelectorAll(".btn.close").forEach(b=>b.addEventListener("click", ()=> closeModal($el)));
  }
  function closeModal($el){
    if(!$el) return;
    $el.classList.add("hidden");
    document.body.classList.remove("no-scroll");
    $el.removeEventListener("click", backdropCloser);
  }
  function backdropCloser(e){
    if(e.target.classList.contains("modal")){
      closeModal(e.currentTarget);
    }
  }

  // ---------------------- Init ----------------------
  async function init(){
    // Giá: tick ngay và 60s/lần
    await fetchPrices();
    setInterval(fetchPrices, 60000);

    // Nếu đã có ví → init nhanh
    if(window.ethereum){
      provider = new ethers.providers.Web3Provider(window.ethereum, "any");
      try{
        const accs = await provider.listAccounts();
        const currentChainId = await window.ethereum.request({ method:"eth_chainId" });
        if(accs?.length && currentChainId === VIC.CHAIN_ID_HEX){
          signer = provider.getSigner();
          account = await signer.getAddress();
          await initContracts();
          await refreshWalletUI();
          await afterConnectedUI();
        }
      }catch(_){}
    }

    // Bind buttons
    $btnConnect?.addEventListener("click", connect);
    $btnDisconnect?.addEventListener("click", disconnect);

    $btnSearch?.addEventListener("click", doSearch);
    $searchInput?.addEventListener("keydown", (e)=>{ if(e.key==="Enter") doSearch(); });

    $btnRegister?.addEventListener("click", ensureRegisteredFlow);
    $btnCreate?.addEventListener("click", openCreateModal);
    $btnSubmitCreate?.addEventListener("click", submitCreate);

    $btnSubmitUpdate?.addEventListener("click", submitUpdate);

    $buyQty?.addEventListener("input", updateBuyTotal);
    $btnSubmitBuy?.addEventListener("click", submitBuy);

    // Nút “Đơn hàng …” có thể gắn sau khi có màn xem đơn (chưa đặc tả đủ)
  }

  document.addEventListener("DOMContentLoaded", init);
})();
