/* ========================================================================
   muaban.vin — app.js (FULL, fixed)
   Build: 2025-09-25T17:07:10.604990Z
   - Ethers v5 (UMD)
   - Viction Mainnet (chainId 88) — explorer https://www.vicscan.xyz
   - Giá VND: dùng số nguyên ≥ 1 (VIN = 100 VIC; VIC lấy từ Binance; USDT/VND từ CoinGecko)
   - ẨN thông tin người bán trên UI
   ======================================================================== */

(() => {
  // ---------------------- Chain ----------------------
  const VIC = {
    CHAIN_ID_DEC: 88,
    CHAIN_ID_HEX: "0x58",
    RPC_URL: "https://rpc.viction.xyz",
    EXPLORER: "https://www.vicscan.xyz",
    NAME: "Viction Mainnet",
    CURRENCY: { name:"VIC", symbol:"VIC", decimals:18 }
  };

  // ---------------------- Addresses ----------------------
  // LƯU Ý: thay bằng địa chỉ của bạn nếu khác
  const MUABAN_ADDR = "0x190FD18820498872354eED9C4C080cB365Cd12E0";
  const VIN_ADDR    = "0x941F63807401efCE8afe3C9d88d368bAA287Fac4";

  // ---------------------- ABIs (JSON chuẩn, KHÔNG dùng dạng rút gọn) ----------------------
  const MUABAN_ABI = [{"inputs": [{"internalType": "address", "name": "vinToken", "type": "address"}], "stateMutability": "nonpayable", "type": "constructor"}, {"anonymous": false, "inputs": [{"indexed": true, "internalType": "uint256", "name": "orderId", "type": "uint256"}, {"indexed": true, "internalType": "uint256", "name": "productId", "type": "uint256"}, {"indexed": true, "internalType": "address", "name": "buyer", "type": "address"}, {"indexed": false, "internalType": "uint256", "name": "quantity", "type": "uint256"}, {"indexed": false, "internalType": "uint256", "name": "vinAmount", "type": "uint256"}], "name": "OrderPlaced", "type": "event"}, {"anonymous": false, "inputs": [{"indexed": true, "internalType": "uint256", "name": "orderId", "type": "uint256"}, {"indexed": false, "internalType": "uint256", "name": "vinAmount", "type": "uint256"}], "name": "OrderRefunded", "type": "event"}, {"anonymous": false, "inputs": [{"indexed": true, "internalType": "uint256", "name": "orderId", "type": "uint256"}, {"indexed": false, "internalType": "uint256", "name": "vinAmount", "type": "uint256"}], "name": "OrderReleased", "type": "event"}, {"anonymous": false, "inputs": [{"indexed": true, "internalType": "uint256", "name": "productId", "type": "uint256"}, {"indexed": true, "internalType": "address", "name": "seller", "type": "address"}, {"indexed": false, "internalType": "string", "name": "name", "type": "string"}, {"indexed": false, "internalType": "uint256", "name": "priceVND", "type": "uint256"}], "name": "ProductCreated", "type": "event"}, {"anonymous": false, "inputs": [{"indexed": true, "internalType": "uint256", "name": "productId", "type": "uint256"}, {"indexed": false, "internalType": "uint256", "name": "priceVND", "type": "uint256"}, {"indexed": false, "internalType": "uint32", "name": "deliveryDaysMax", "type": "uint32"}, {"indexed": false, "internalType": "bool", "name": "active", "type": "bool"}], "name": "ProductUpdated", "type": "event"}, {"anonymous": false, "inputs": [{"indexed": true, "internalType": "address", "name": "user", "type": "address"}], "name": "Registered", "type": "event"}, {"inputs": [], "name": "REG_FEE", "outputs": [{"internalType": "uint256", "name": "", "type": "uint256"}], "stateMutability": "view", "type": "function"}, {"inputs": [{"internalType": "uint256", "name": "orderId", "type": "uint256"}], "name": "confirmReceipt", "outputs": [], "stateMutability": "nonpayable", "type": "function"}, {"inputs": [{"internalType": "string", "name": "name", "type": "string"}, {"internalType": "string", "name": "descriptionCID", "type": "string"}, {"internalType": "string", "name": "imageCID", "type": "string"}, {"internalType": "uint256", "name": "priceVND", "type": "uint256"}, {"internalType": "uint32", "name": "deliveryDaysMax", "type": "uint32"}, {"internalType": "address", "name": "payoutWallet", "type": "address"}, {"internalType": "bool", "name": "active", "type": "bool"}], "name": "createProduct", "outputs": [{"internalType": "uint256", "name": "pid", "type": "uint256"}], "stateMutability": "nonpayable", "type": "function"}, {"inputs": [{"internalType": "uint256", "name": "oid", "type": "uint256"}], "name": "getOrder", "outputs": [{"components": [{"internalType": "uint256", "name": "orderId", "type": "uint256"}, {"internalType": "uint256", "name": "productId", "type": "uint256"}, {"internalType": "address", "name": "buyer", "type": "address"}, {"internalType": "address", "name": "seller", "type": "address"}, {"internalType": "uint256", "name": "quantity", "type": "uint256"}, {"internalType": "uint256", "name": "vinAmount", "type": "uint256"}, {"internalType": "uint256", "name": "placedAt", "type": "uint256"}, {"internalType": "uint256", "name": "deadline", "type": "uint256"}, {"internalType": "enum MuabanVND.OrderStatus", "name": "status", "type": "uint8"}, {"internalType": "string", "name": "buyerInfoCipher", "type": "string"}], "internalType": "struct MuabanVND.Order", "name": "", "type": "tuple"}], "stateMutability": "view", "type": "function"}, {"inputs": [{"internalType": "uint256", "name": "pid", "type": "uint256"}], "name": "getProduct", "outputs": [{"components": [{"internalType": "uint256", "name": "productId", "type": "uint256"}, {"internalType": "address", "name": "seller", "type": "address"}, {"internalType": "string", "name": "name", "type": "string"}, {"internalType": "string", "name": "descriptionCID", "type": "string"}, {"internalType": "string", "name": "imageCID", "type": "string"}, {"internalType": "uint256", "name": "priceVND", "type": "uint256"}, {"internalType": "uint32", "name": "deliveryDaysMax", "type": "uint32"}, {"internalType": "address", "name": "payoutWallet", "type": "address"}, {"internalType": "bool", "name": "active", "type": "bool"}, {"internalType": "uint64", "name": "createdAt", "type": "uint64"}, {"internalType": "uint64", "name": "updatedAt", "type": "uint64"}], "internalType": "struct MuabanVND.Product", "name": "", "type": "tuple"}], "stateMutability": "view", "type": "function"}, {"inputs": [{"internalType": "address", "name": "seller", "type": "address"}], "name": "getSellerProductIds", "outputs": [{"internalType": "uint256[]", "name": "", "type": "uint256[]"}], "stateMutability": "view", "type": "function"}, {"inputs": [{"internalType": "uint256", "name": "", "type": "uint256"}], "name": "orders", "outputs": [{"internalType": "uint256", "name": "orderId", "type": "uint256"}, {"internalType": "uint256", "name": "productId", "type": "uint256"}, {"internalType": "address", "name": "buyer", "type": "address"}, {"internalType": "address", "name": "seller", "type": "address"}, {"internalType": "uint256", "name": "quantity", "type": "uint256"}, {"internalType": "uint256", "name": "vinAmount", "type": "uint256"}, {"internalType": "uint256", "name": "placedAt", "type": "uint256"}, {"internalType": "uint256", "name": "deadline", "type": "uint256"}, {"internalType": "enum MuabanVND.OrderStatus", "name": "status", "type": "uint8"}, {"internalType": "string", "name": "buyerInfoCipher", "type": "string"}], "stateMutability": "view", "type": "function"}, {"inputs": [], "name": "owner", "outputs": [{"internalType": "address", "name": "", "type": "address"}], "stateMutability": "view", "type": "function"}, {"inputs": [], "name": "payRegistration", "outputs": [], "stateMutability": "nonpayable", "type": "function"}, {"inputs": [{"internalType": "uint256", "name": "productId", "type": "uint256"}, {"internalType": "uint256", "name": "quantity", "type": "uint256"}, {"internalType": "uint256", "name": "vinPerVND", "type": "uint256"}, {"internalType": "string", "name": "buyerInfoCipher", "type": "string"}], "name": "placeOrder", "outputs": [{"internalType": "uint256", "name": "oid", "type": "uint256"}], "stateMutability": "nonpayable", "type": "function"}, {"inputs": [{"internalType": "uint256", "name": "", "type": "uint256"}], "name": "products", "outputs": [{"internalType": "uint256", "name": "productId", "type": "uint256"}, {"internalType": "address", "name": "seller", "type": "address"}, {"internalType": "string", "name": "name", "type": "string"}, {"internalType": "string", "name": "descriptionCID", "type": "string"}, {"internalType": "string", "name": "imageCID", "type": "string"}, {"internalType": "uint256", "name": "priceVND", "type": "uint256"}, {"internalType": "uint32", "name": "deliveryDaysMax", "type": "uint32"}, {"internalType": "address", "name": "payoutWallet", "type": "address"}, {"internalType": "bool", "name": "active", "type": "bool"}, {"internalType": "uint64", "name": "createdAt", "type": "uint64"}, {"internalType": "uint64", "name": "updatedAt", "type": "uint64"}], "stateMutability": "view", "type": "function"}, {"inputs": [{"internalType": "uint256", "name": "orderId", "type": "uint256"}], "name": "refundIfExpired", "outputs": [], "stateMutability": "nonpayable", "type": "function"}, {"inputs": [{"internalType": "address", "name": "", "type": "address"}], "name": "registered", "outputs": [{"internalType": "bool", "name": "", "type": "bool"}], "stateMutability": "view", "type": "function"}, {"inputs": [{"internalType": "address", "name": "", "type": "address"}, {"internalType": "uint256", "name": "", "type": "uint256"}], "name": "sellerProducts", "outputs": [{"internalType": "uint256", "name": "", "type": "uint256"}], "stateMutability": "view", "type": "function"}, {"inputs": [{"internalType": "uint256", "name": "pid", "type": "uint256"}, {"internalType": "bool", "name": "active", "type": "bool"}], "name": "setProductActive", "outputs": [], "stateMutability": "nonpayable", "type": "function"}, {"inputs": [{"internalType": "uint256", "name": "pid", "type": "uint256"}, {"internalType": "uint256", "name": "priceVND", "type": "uint256"}, {"internalType": "uint32", "name": "deliveryDaysMax", "type": "uint32"}, {"internalType": "address", "name": "payoutWallet", "type": "address"}, {"internalType": "bool", "name": "active", "type": "bool"}], "name": "updateProduct", "outputs": [], "stateMutability": "nonpayable", "type": "function"}, {"inputs": [], "name": "vin", "outputs": [{"internalType": "contract IERC20", "name": "", "type": "address"}], "stateMutability": "view", "type": "function"}, {"inputs": [], "name": "vinDecimals", "outputs": [{"internalType": "uint8", "name": "", "type": "uint8"}], "stateMutability": "view", "type": "function"}];
  const ERC20_ABI  = [{"constant": true, "inputs": [], "name": "decimals", "outputs": [{"name": "", "type": "uint8"}], "payable": false, "stateMutability": "view", "type": "function"}, {"constant": true, "inputs": [{"name": "owner", "type": "address"}], "name": "balanceOf", "outputs": [{"name": "", "type": "uint256"}], "payable": false, "stateMutability": "view", "type": "function"}, {"constant": true, "inputs": [{"name": "owner", "type": "address"}, {"name": "spender", "type": "address"}], "name": "allowance", "outputs": [{"name": "", "type": "uint256"}], "payable": false, "stateMutability": "view", "type": "function"}, {"constant": false, "inputs": [{"name": "spender", "type": "address"}, {"name": "value", "type": "uint256"}], "name": "approve", "outputs": [{"name": "", "type": "bool"}], "payable": false, "stateMutability": "nonpayable", "type": "function"}];

  // ---------------------- Price endpoints ----------------------
  const BINANCE_VICUSDT = "https://api.binance.com/api/v3/ticker/price?symbol=VICUSDT";
  const COINGECKO_USDT_VND = "https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=vnd";

  // ---------------------- Scan bounds ----------------------
  const MAX_PRODUCTS_SCAN = 200;
  const MAX_ORDERS_SCAN   = 2000;
  const MAX_EMPTY_STREAK  = 25;

  // ---------------------- State ----------------------
  let provider, signer, account;
  let muaban, vin;
  let vinDecimals = 18;
  let priceVIC_USDT = null, priceUSDT_VND = null;
  let vndPerVIN_INT = null;        // integer >=1
  let vinPerVNDWei  = null;        // BigNumber (wei per 1 VND)

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

  const $ordersBuySection = $("ordersBuySection");
  const $ordersSellSection = $("ordersSellSection");
  const $ordersBuyList = $("ordersBuyList");
  const $ordersSellList = $("ordersSellList");

  // Create form
  const $formCreate = $("formCreate");
  const $createName   = $("createName");
  const $createIPFS   = $("createIPFS");
  const $createUnit   = $("createUnit");
  const $createPrice  = $("createPrice");
  const $createWallet = $("createWallet");
  const $createDays   = $("createDays");
  const $btnSubmitCreate = $("btnSubmitCreate");

  // Update form
  const $formUpdate = $("formUpdate");
  const $updatePid   = $("updatePid");
  const $updatePrice = $("updatePrice");
  const $updateDays  = $("updateDays");
  const $updateWallet= $("updateWallet");
  const $updateActive= $("updateActive");
  const $btnSubmitUpdate = $("btnSubmitUpdate");

  // Buy form
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
  const fmtVIN = (wei) => { try{ return ethers.utils.formatUnits(wei, vinDecimals); }catch(_){ return "0"; } };
  function toHttpIPFS(link){ if(!link) return ""; return link.startsWith("ipfs://")?`https://ipfs.io/ipfs/${link.slice(7)}`:link; }
  const explorerTx = (hash) => `${VIC.EXPLORER}/tx/${hash}`;

  // Toast
  let __toastHost = null;
  function toast(msg,type="info",ms=4200){
    if(!__toastHost){
      __toastHost = document.createElement("div");
      __toastHost.style.cssText = "position:fixed;top:16px;right:16px;z-index:99999;display:flex;flex-direction:column;gap:10px;";
      document.body.appendChild(__toastHost);
    }
    const el = document.createElement("div");
    el.style.cssText = "min-width:280px;max-width:520px;padding:12px 14px;border-radius:12px;color:#fff;box-shadow:0 4px 16px rgba(0,0,0,.15)";
    el.style.background = type==="error"?"#ef4444":type==="warn"?"#f59e0b":"#3b82f6";
    el.innerHTML = `<div style="font-weight:600;margin-bottom:4px;">${type.toUpperCase()}</div><div>${msg||""}</div>`;
    __toastHost.appendChild(el);
    setTimeout(()=>{ el.style.opacity="0"; el.style.transform="translateY(-6px)"; el.style.transition="all .25s"; }, ms-250);
    setTimeout(()=>{ try{__toastHost.removeChild(el);}catch(_){ } }, ms);
  }

  function prettifyError(e){
    const raw = e?.error?.message || e?.data?.message || e?.reason || e?.message || String(e);
    if(/missing trie node/i.test(raw)) return "Nút RPC đang đồng bộ hoặc không ổn định (missing trie node). Vui lòng thử lại sau hoặc đổi RPC.";
    if(/user rejected|denied|4001/i.test(raw)) return "Bạn đã từ chối ký giao dịch.";
    if(/insufficient funds/i.test(raw)) return "Ví không đủ VIC để trả phí gas.";
    if(/invalid address/i.test(raw)) return "Địa chỉ ví không hợp lệ.";
    if(/CALL_EXCEPTION|execution reverted|revert/i.test(raw)) return "Giao dịch bị revert trên chuỗi (kiểm tra tham số/allowance/đăng ký).";
    return raw;
  }
  const extractReason = (e) => String(e?.error?.message || e?.data?.message || e?.reason || e?.message || e || "");
  function mapReasonToVN(r){
    if(!r) return null;
    if(/NOT_REGISTERED/i.test(r)) return "Bạn chưa Đăng ký ví trên hệ thống.";
    if(/PRICE_REQUIRED/i.test(r)) return "Giá bán (VND) phải > 0.";
    if(/DELIVERY_REQUIRED/i.test(r)) return "Số ngày giao hàng phải > 0.";
    if(/PAYOUT_WALLET_ZERO/i.test(r)) return "Ví nhận thanh toán không được để trống.";
    if(/VIN_TRANSFER_FAIL/i.test(r)) return "Chuyển VIN thất bại (kiểm tra số dư/allowance).";
    if(/PRODUCT_NOT_FOUND/i.test(r)) return "Sản phẩm không tồn tại.";
    if(/PRODUCT_NOT_ACTIVE/i.test(r)) return "Sản phẩm đã tắt bán.";
    if(/QUANTITY_REQUIRED/i.test(r)) return "Số lượng phải > 0.";
    if(/VIN_PER_VND_REQUIRED/i.test(r)) return "Thiếu tham số tỷ giá VIN/VND.";
    if(/NOT_SELLER/i.test(r)) return "Bạn không phải người bán của sản phẩm này.";
    if(/NOT_PLACED/i.test(r)) return "Trạng thái đơn hàng không phù hợp.";
    if(/NOT_BUYER/i.test(r)) return "Bạn không phải người mua của đơn này.";
    if(/NOT_EXPIRED/i.test(r)) return "Chưa quá hạn giao hàng.";
    return null;
  }

  // ---------------------- Chain ----------------------
  async function ensureViction(){
    if(!window.ethereum){ toast("Không thấy ví (MetaMask).","warn"); return false; }
    const eth = window.ethereum;
    const chainId = await eth.request({ method:"eth_chainId" });
    if(chainId === VIC.CHAIN_ID_HEX) return true;
    try{
      await eth.request({ method:"wallet_switchEthereumChain", params:[{chainId:VIC.CHAIN_ID_HEX}] });
      return true;
    }catch(err){
      if(err && err.code === 4902){
        await eth.request({
          method:"wallet_addEthereumChain",
          params:[{ chainId:VIC.CHAIN_ID_HEX, chainName:VIC.NAME, nativeCurrency:VIC.CURRENCY, rpcUrls:[VIC.RPC_URL], blockExplorerUrls:[VIC.EXPLORER] }]
        });
        return true;
      }
      toast(`Không chuyển được chain: ${prettifyError(err)}`,"error",6500);
      return false;
    }
  }

  async function connect(){
    if(!window.ethereum) return toast("Không thấy ví (MetaMask).","warn");
    try{
      provider = new ethers.providers.Web3Provider(window.ethereum, "any");
      await provider.send("eth_requestAccounts", []);
      signer = provider.getSigner();
      account = await signer.getAddress();
      const ok = await ensureViction(); if(!ok) return;
      await initContracts();
      await refreshWalletUI();
      await afterConnectedUI();
      window.ethereum?.on?.("accountsChanged", ()=> location.reload());
      window.ethereum?.on?.("chainChanged", ()=> location.reload());
    }catch(err){ toast(`Lỗi kết nối ví: ${prettifyError(err)}`,"error",6500); }
  }
  const disconnect = ()=> location.reload();

  async function initContracts(){
    vin = new ethers.Contract(VIN_ADDR, ERC20_ABI, signer);
    try{ vinDecimals = Number(await vin.decimals())||18; }catch(_){ vinDecimals = 18; }
    muaban = new ethers.Contract(MUABAN_ADDR, MUABAN_ABI, signer);
  }

  async function refreshWalletUI(){
    try{
      if(!provider || !account) return;
      const net = await provider.getNetwork();
      if(!net || Number(net.chainId) !== 88) return; // only fetch when on Viction
      const vicBal = await provider.getBalance(account);
      const vinBal = await vin.balanceOf(account);
      vicBalance.textContent = `VIC: ${Number(ethers.utils.formatEther(vicBal)).toFixed(4)}`;
      vinBalance.textContent = `VIN: ${Number(fmtVIN(vinBal)).toFixed(4)}`;
      accountShort.textContent = short(account);
      accountShort.href = `${VIC.EXPLORER}/address/${account}`;
      btnConnect.classList.add("hidden");
      walletBox.classList.remove("hidden");
    }catch(err){
      const raw = String(err?.message || err);
      if(/missing trie node/i.test(raw)){
        // mute noisy RPC error when not fully synced / wrong chain probing
        console.warn("[refreshWalletUI] RPC node missing trie node, skip.");
        return;
      }
      toast(`Không đọc được số dư: ${prettifyError(err)}`,"error",6500);
    }
  }
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
    }catch(err){ toast(prettifyError(err),"error",6500); }
  }

  // ---------------------- Pricing ----------------------
  async function fetchPrices(){
    try{
      const b = await fetch(BINANCE_VICUSDT, { cache:"no-store" }).then(r=>r.json());
      priceVIC_USDT = Number(b?.price||0);
      const c = await fetch(COINGECKO_USDT_VND, { cache:"no-store" }).then(r=>r.json());
      priceUSDT_VND = Number(c?.tether?.vnd||0);
      if(!(priceVIC_USDT>0) || !(priceUSDT_VND>0)) throw new Error("Nguồn giá không khả dụng");
      const vndPerVIN = priceVIC_USDT * 100 * priceUSDT_VND;
      vndPerVIN_INT = Math.max(1, Math.round(vndPerVIN));
      const one = ethers.utils.parseUnits("1", vinDecimals);
      vinPerVNDWei = one.div(ethers.BigNumber.from(vndPerVIN_INT.toString()));
      if($vinPrice) $vinPrice.textContent = `1 VIN = ${vndPerVIN_INT.toLocaleString("vi-VN")} VND`;
    }catch(_){
      if($vinPrice) $vinPrice.textContent = "Loading price...";
      vndPerVIN_INT = null; vinPerVNDWei = null;
    }
  }

  // ---------------------- Registration ----------------------
  async function ensureRegistered(){
    const isReg = await muaban.registered(account);
    if(isReg) return true;
    const fee = await muaban.REG_FEE();
    toast("Ví chưa đăng ký. Đang mở ví để đăng ký…","info");
    const tx = await muaban.payRegistration({ from:account, gasLimit: ethers.BigNumber.from("300000") });
    toast(`Đăng ký… <a href="${explorerTx(tx.hash)}" target="_blank" rel="noopener">tx</a>`,"info",6000);
    await tx.wait();
    toast("Đăng ký ví thành công.","success");
    return true;
  }

  // ---------------------- Products ----------------------
  let PRODUCTS = [];
  function renderProducts(list){
    const keyword = ($searchInput?.value||"").trim().toLowerCase();
    const filtered = list.filter(x=> !keyword || String(x.p.name||"").toLowerCase().includes(keyword));
    if(!filtered.length){
      $productList.innerHTML = `<div class="product-card" style="grid-column:span 12;">Không có sản phẩm.</div>`;
      return;
    }
    $productList.innerHTML = filtered.map(({pid,p})=>{
      const img = p.imageCID ? toHttpIPFS(p.imageCID) : "";
      const badge = p.active ? `<span class="stock-badge">Còn hàng</span>` : `<span class="stock-badge out">Hết hàng</span>`;
      const priceInt = parseInt((p.priceVND?.toString?.()||p.priceVND||0),10);
      const priceHtml = `<span class="price-vnd">${fmtVND(priceInt)} VND</span>`;
      const isSeller = account && p.seller && (account.toLowerCase()===p.seller.toLowerCase());
      const actions = [
        (!isSeller && p.active) ? `<button class="btn primary" data-act="buy" data-pid="${pid}">Mua</button>` : "",
        (isSeller) ? `<button class="btn" data-act="update" data-pid="${pid}">Cập nhật</button>` : ""
      ].filter(Boolean).join(" ");
      return `
      <div class="product-card" data-pid="${pid}">
        <img class="product-thumb" src="${img||'https://ipfs.io/ipfs/'}" alt="">
        <div class="product-info">
          <div class="product-top">
            <h3 class="product-title">${String(p.name||"").replace(/</g,"&lt;")}</h3>
            ${badge}
          </div>
          <div class="product-meta">${priceHtml}</div>
          <div class="card-actions">${actions}</div>
        </div>
      </div>`;
    }).join("");
    $productList.querySelectorAll("[data-act=buy]").forEach(b=> b.addEventListener("click", e=> openBuyModal(parseInt(e.currentTarget.dataset.pid,10))));
    $productList.querySelectorAll("[data-act=update]").forEach(b=> b.addEventListener("click", e=> openUpdateModal(parseInt(e.currentTarget.dataset.pid,10))));
  }

  async function loadProducts(){
    if(!$productList) return;
    $productList.innerHTML = "";
    PRODUCTS = [];
    let empty = 0;
    for(let pid=1; pid<=MAX_PRODUCTS_SCAN; pid++){
      try{
        const p = await muaban.getProduct(pid);
        if(!p || !p.seller || p.seller===ethers.constants.AddressZero){
          empty++;
          if(empty>=MAX_EMPTY_STREAK) break;
          continue;
        }
        empty = 0;
        PRODUCTS.push({ pid, p });
      }catch(_){
        empty++;
        if(empty>=MAX_EMPTY_STREAK) break;
      }
    }
    renderProducts(PRODUCTS);
  }

  // ---------------------- Create / Update ----------------------
  function openCreateModal(){
    if(!$formCreate) return;
    $createName.value = "";
    $createIPFS.value = "";
    $createUnit.value = "";
    $createPrice.value = "";
    $createWallet.value = account||"";
    $createDays.value = "7";
    $formCreate.classList.remove("hidden");
    document.body.classList.add("no-scroll");
  }
  function closeModal(el){ if(!el) return; el.classList.add("hidden"); document.body.classList.remove("no-scroll"); }

  async function submitCreate(){
    try{
      if(!vndPerVIN_INT || !vinPerVNDWei) await fetchPrices();
      await ensureRegistered();

      const name  = ($createName.value||"").trim();
      const ipfs  = ($createIPFS.value||"").trim();
      let priceV  = Math.floor(Number($createPrice.value||0));
      const days  = parseInt($createDays.value,10)>>>0;
      const wallet= ($createWallet.value||"").trim();
      if(!name) throw new Error("Vui lòng nhập Tên sản phẩm.");
      if(!(priceV>0)) throw new Error("Giá bán (VND) phải là số dương.");
      if(!(days>0)) throw new Error("Số ngày giao hàng phải > 0.");
      if(!ethers.utils.isAddress(wallet)) throw new Error("Ví nhận không hợp lệ.");

      const descriptionCID = "";
      const imageCID = ipfs;
      const priceVND = ethers.BigNumber.from(priceV.toString());
      const deliveryDaysMax = days;
      const payoutWallet = wallet;
      const active = true;

      const overrides = {
        from: account,
        gasLimit: ethers.BigNumber.from("1500000"),
      };
      try{
        const fee = await provider.getFeeData();
        if(fee?.gasPrice) overrides.gasPrice = fee.gasPrice;
      }catch(_){
        overrides.gasPrice = ethers.utils.parseUnits("1","gwei");
      }

      $btnSubmitCreate.disabled = true;
      $btnSubmitCreate.textContent = "Đang gửi giao dịch…";
      toast("Đang gửi giao dịch tạo sản phẩm… Hãy ký trong MetaMask.","info",6000);

      let tx;
      try{
        tx = await muaban.createProduct(name, descriptionCID, imageCID, priceVND, deliveryDaysMax, payoutWallet, active, overrides);
      }catch(sendErr){
        try{ await muaban.callStatic.createProduct(name, descriptionCID, imageCID, priceVND, deliveryDaysMax, payoutWallet, active, { from:account }); }
        catch(simErr){ const r = mapReasonToVN(extractReason(simErr)); if(r) throw new Error(r); }
        throw sendErr;
      }
      toast(`Đã gửi TX: <a href="${explorerTx(tx.hash)}" target="_blank" rel="noopener">VicScan</a>`,"info",6500);
      const rc = await tx.wait();
      if(!rc || rc.status!==1) throw new Error("Giao dịch bị revert.");
      toast("Tạo sản phẩm THÀNH CÔNG.","success");
      closeModal($formCreate);
      await loadProducts();
    }catch(err){
      console.error("[submitCreate]", err);
      toast(prettifyError(err),"error",9000);
    }finally{
      $btnSubmitCreate.disabled = false;
      $btnSubmitCreate.textContent = "Đăng";
    }
  }

  async function openUpdateModal(pid){
    try{
      const p = await muaban.getProduct(pid);
      if(!p || !p.seller) return toast("Sản phẩm không tồn tại.","warn");
      $updatePid.value = String(pid);
      $updatePrice.value = parseInt((p.priceVND?.toString?.()||p.priceVND||0),10);
      $updateDays.value = String(p.deliveryDaysMax||7);
      $updateWallet.value = p.payoutWallet||account||"";
      $updateActive.checked = !!p.active;
      $formUpdate.classList.remove("hidden"); document.body.classList.add("no-scroll");
    }catch(err){ toast(prettifyError(err),"error",7000); }
  }
  async function submitUpdate(){
    try{
      const pid = parseInt($updatePid.value,10);
      const price = Math.floor(Number($updatePrice.value||0));
      const days  = parseInt($updateDays.value,10)>>>0;
      const wallet= ($updateWallet.value||"").trim();
      const active= !!$updateActive.checked;
      if(!(pid>0)) throw new Error("PID không hợp lệ.");
      if(!(price>0)) throw new Error("Giá phải > 0.");
      if(!(days>0)) throw new Error("Số ngày phải > 0.");
      if(!ethers.utils.isAddress(wallet)) throw new Error("Ví nhận không hợp lệ.");
      const priceVND = ethers.BigNumber.from(price.toString());
      let tx;
      try{ tx = await muaban.updateProduct(pid, priceVND, days, wallet, active, { from:account, gasLimit: ethers.BigNumber.from("700000") }); }
      catch(sendErr){ try{ await muaban.callStatic.updateProduct(pid, priceVND, days, wallet, active, { from:account }); }catch(simErr){ const r=mapReasonToVN(extractReason(simErr)); if(r) throw new Error(r); } throw sendErr; }
      toast(`Đang cập nhật… <a href="${explorerTx(tx.hash)}" target="_blank" rel="noopener">tx</a>`,"info",6000);
      await tx.wait();
      closeModal($formUpdate);
      await loadProducts();
      toast("Cập nhật sản phẩm thành công.","success");
    }catch(err){ toast(prettifyError(err),"error",8000); }
  }

  // ---------------------- Buy flow ----------------------
  let BUYING_PID = null, BUYING_PRODUCT = null;
  async function openBuyModal(pid){
    try{
      const p = await muaban.getProduct(pid);
      if(!p || !p.active) return toast("Sản phẩm không còn bán.","warn");
      BUYING_PID = pid; BUYING_PRODUCT = p;
      const img = p.imageCID ? toHttpIPFS(p.imageCID) : "";
      $buyProductInfo.innerHTML = `
        <div><b>${String(p.name||"").replace(/</g,"&lt;")}</b></div>
        <div>Giá: <span class="order-strong">${fmtVND(parseInt((p.priceVND?.toString?.()||p.priceVND||0),10))} VND</span></div>
        ${img?`<div><img src="${img}" style="width:100%;max-height:220px;object-fit:cover;border-radius:8px;border:1px solid #eef1f5" /></div>`:""}
      `;
      $buyName.value=""; $buyAddress.value=""; $buyPhone.value=""; $buyNote.value=""; $buyQty.value="1";
      await updateBuyTotal();
      $formBuy.classList.remove("hidden"); document.body.classList.add("no-scroll");
    }catch(err){ toast(prettifyError(err),"error",7000); }
  }
  async function updateBuyTotal(){
    try{
      if(!vndPerVIN_INT) await fetchPrices();
      const qty = Math.max(1, parseInt($buyQty.value,10)||1);
      const priceVND = BUYING_PRODUCT ? parseInt((BUYING_PRODUCT.priceVND?.toString?.()||BUYING_PRODUCT.priceVND||0),10) : 0;
      const totalVND = priceVND * qty;
      if(vndPerVIN_INT>0){
        const est = totalVND / vndPerVIN_INT;
        $buyTotalVIN.textContent = `Tổng VIN cần trả (ước tính): ${est.toFixed(6)} VIN`;
      }else{ $buyTotalVIN.textContent = "Tổng VIN cần trả: (đang tải giá)"; }
    }catch(_){
      $buyTotalVIN.textContent = "Tổng VIN cần trả: (lỗi giá)";
    }
  }
  async function submitBuy(){
    try{
      if(!BUYING_PRODUCT) throw new Error("Thiếu thông tin sản phẩm.");
      if(!vndPerVIN_INT || !vinPerVNDWei) await fetchPrices();
      const qty = Math.max(1, parseInt($buyQty.value,10)||1);

      const payload = JSON.stringify({
        name: ($buyName.value||"").trim(),
        address: ($buyAddress.value||"").trim(),
        phone: ($buyPhone.value||"").trim(),
        note: ($buyNote.value||"").trim()
      });
      const buyerInfoCipher = btoa(unescape(encodeURIComponent(payload)));
      const priceVND = ethers.BigNumber.from(parseInt((BUYING_PRODUCT.priceVND?.toString?.()||BUYING_PRODUCT.priceVND||0),10).toString());
      const totalVND = priceVND.mul(qty.toString());
      const one = ethers.utils.parseUnits("1", vinDecimals);
      const estVIN = totalVND.mul(vinPerVNDWei).add(one.sub(1)).div(one); // ceil

      const allowance = await vin.allowance(account, MUABAN_ADDR);
      if(allowance.lt(estVIN)){
        const tx1 = await vin.approve(MUABAN_ADDR, estVIN);
        toast(`Approve ~${fmtVIN(estVIN)} VIN… <a href="${explorerTx(tx1.hash)}" target="_blank" rel="noopener">tx</a>`,"info",6000);
        await tx1.wait();
      }

      let tx2;
      try{ tx2 = await muaban.placeOrder(BUYING_PID, ethers.BigNumber.from(qty.toString()), vinPerVNDWei, buyerInfoCipher, { from:account, gasLimit: ethers.BigNumber.from("900000") }); }
      catch(sendErr){ try{ await muaban.callStatic.placeOrder(BUYING_PID, ethers.BigNumber.from(qty.toString()), vinPerVNDWei, buyerInfoCipher, { from:account }); }catch(simErr){ const r=mapReasonToVN(extractReason(simErr)); if(r) throw new Error(r); } throw sendErr; }
      toast(`Đặt hàng… <a href="${explorerTx(tx2.hash)}" target="_blank" rel="noopener">tx</a>`,"info",6000);
      await tx2.wait();
      toast("Đặt hàng thành công. VIN đã ký quỹ.","success");
      closeModal($formBuy);
    }catch(err){ toast(prettifyError(err),"error",8000); }
  }

  // ---------------------- Orders (buyer/seller) ----------------------
  function emptyOrderCard(msg="Chưa có đơn nào."){
    return `<div class="order-card empty">${msg}</div>`;
  }
  async function loadOrdersForBuyer(){
    if(!$ordersBuyList) return;
    $ordersBuyList.innerHTML = "...";
    const mine = [];
    let empty=0;
    for(let oid=1; oid<=MAX_ORDERS_SCAN; oid++){
      try{
        const o = await muaban.getOrder(oid);
        if(!o || !o.seller || o.seller===ethers.constants.AddressZero){ empty++; if(empty>=MAX_EMPTY_STREAK) break; continue; }
        empty=0;
        if(o.buyer && account && o.buyer.toLowerCase()===account.toLowerCase()) mine.push({oid, o});
      }catch(_){
        empty++; if(empty>=MAX_EMPTY_STREAK) break;
      }
    }
    if(!mine.length){ $ordersBuyList.innerHTML = emptyOrderCard("Bạn chưa có đơn mua nào."); return; }
    const vinFmt = (wei)=> { try{ return ethers.utils.formatUnits(wei, vinDecimals); }catch(_){ return "0"; } };
    $ordersBuyList.innerHTML = mine.map(({oid,o})=>{
      const status = String(o.status||0);
      const priceVIN = vinFmt(o.vinAmount||0);
      return `<div class="order-card">
        <div><b>Đơn #${oid}</b></div>
        <div>Số VIN ký quỹ: <span class="order-strong">${priceVIN}</span></div>
        <div>Trạng thái: ${status}</div>
      </div>`;
    }).join("");
  }
  async function loadOrdersForSeller(){
    if(!$ordersSellList) return;
    $ordersSellList.innerHTML = "...";
    const mine = [];
    let empty=0;
    for(let oid=1; oid<=MAX_ORDERS_SCAN; oid++){
      try{
        const o = await muaban.getOrder(oid);
        if(!o || !o.seller || o.seller===ethers.constants.AddressZero){ empty++; if(empty>=MAX_EMPTY_STREAK) break; continue; }
        empty=0;
        if(o.seller && account && o.seller.toLowerCase()===account.toLowerCase()) mine.push({oid, o});
      }catch(_){
        empty++; if(empty>=MAX_EMPTY_STREAK) break;
      }
    }
    if(!mine.length){ $ordersSellList.innerHTML = emptyOrderCard("Bạn chưa có đơn bán nào."); return; }
    const vinFmt = (wei)=> { try{ return ethers.utils.formatUnits(wei, vinDecimals); }catch(_){ return "0"; } };
    $ordersSellList.innerHTML = mine.map(({oid,o})=>{
      const status = String(o.status||0);
      const priceVIN = vinFmt(o.vinAmount||0);
      return `<div class="order-card">
        <div><b>Đơn #${oid}</b></div>
        <div>Số VIN ký quỹ: <span class="order-strong">${priceVIN}</span></div>
        <div>Trạng thái: ${status}</div>
      </div>`;
    }).join("");
  }

  // ---------------------- Search ----------------------
  const doSearch = ()=> renderProducts(PRODUCTS);

  // ---------------------- Init ----------------------
  async function init(){
    await fetchPrices();
    setInterval(fetchPrices, 60000);

    if(window.ethereum){
      provider = new ethers.providers.Web3Provider(window.ethereum, "any");
      try{
        const accs = await provider.listAccounts();
        const chainId = await window.ethereum.request({ method:"eth_chainId" });
        if(accs?.length && chainId === VIC.CHAIN_ID_HEX){
          signer = provider.getSigner();
          account = await signer.getAddress();
          await initContracts();
          await refreshWalletUI();
          await afterConnectedUI();
        }
      }catch(_){}
    }

    $btnConnect?.addEventListener("click", connect);
    $btnDisconnect?.addEventListener("click", ()=> location.reload());

    $btnRegister?.addEventListener("click", ensureRegistered);
    $btnCreate?.addEventListener("click", ()=> openCreateModal());
    $btnSubmitCreate?.addEventListener("click", submitCreate);

    $btnSubmitUpdate?.addEventListener("click", submitUpdate);

    $btnOrdersBuy?.addEventListener("click", ()=>{
      $ordersSellSection.classList.add("hidden");
      $ordersBuySection.classList.remove("hidden");
      loadOrdersForBuyer();
    });
    $btnOrdersSell?.addEventListener("click", ()=>{
      $ordersBuySection.classList.add("hidden");
      $ordersSellSection.classList.remove("hidden");
      loadOrdersForSeller();
    });

    $btnSearch?.addEventListener("click", doSearch);
    $searchInput?.addEventListener("keydown", (e)=>{ if(e.key==="Enter") doSearch(); });

    $buyQty?.addEventListener("input", updateBuyTotal);
    $btnSubmitBuy?.addEventListener("click", submitBuy);
  }

  document.addEventListener("DOMContentLoaded", init);
})();
