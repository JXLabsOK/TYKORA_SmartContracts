export const ADDRESSES = {
  rootstock: {
    mainnet: {
      DoC: "0xe700691da7b9851f2f35f8b8182c69c53ccad9db",
      kDOC: "0x544eb90e766b405134b3b3f62b6b4c23fcd5fda2",
      USDRIF: "0x3a15461d8ae0f0fb5fa2629e9da7d66a794a6e37",
      KUSDRIF: "0xddf3ce45fcf080df61ee61dac5ddefef7ed4f46c",
    },
    testnet: {
      DoC: "0xcb46c0ddc60d18efeb0e586c17af6ea36452dae0",   // DOC (Sovryn testnet)
      tDOC: "0x494154243ac77c6ab90dfa0d4d42dd411e1df5f3", // tDOC (underlying de kDOC testnet)
      kDOC: "0xe7b4770af8152fc1a0e13d08e70a8c9a70f4d9d9",  
      USDRIF: "",
      KUSDRIF: "",   
    },
  },
} as const;