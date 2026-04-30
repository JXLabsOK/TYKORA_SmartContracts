export const ADDRESSES = {
  rootstock: {
    mainnet: {
      DoC: "0xe700691da7b9851f2f35f8b8182c69c53ccad9db",
      kDOC: "0x544eb90e766b405134b3b3f62b6b4c23fcd5fda2",
      USDRIF: "0x3a15461d8ae0f0fb5fa2629e9da7d66a794a6e37",
      KUSDRIF: "0xddf3ce45fcf080df61ee61dac5ddefef7ed4f46c",

      // Sovryn
      iDOC: "0xd8D25f03EBbA94E15Df2eD4d6D38276B595593c1",
      sovrynProtocol: "0x5A0D867e0D70Fcc6Ade25C3F1B89d618b5B4Eaa7",
      sovrynPriceFeeds: "0x437AC62769f386b2d238409B7f0a7596d36506e4",
      sovrynLoanTokenLogicProxy: "0x8Cf4737DA60c5F04A3b1e3D63a4ed84a7f8fF26e",
      sovrynLoanTokenLogicLM: "0xfaffde7161C58743B86a22EF268245560aC705dD",
    },
    testnet: {
      DoC: "0xcb46c0ddc60d18efeb0e586c17af6ea36452dae0",   // DOC (Sovryn testnet)
      tDOC: "0x494154243ac77c6ab90dfa0d4d42dd411e1df5f3", // tDOC (underlying de kDOC testnet)
      kDOC: "0xe7b4770af8152fc1a0e13d08e70a8c9a70f4d9d9",  
      USDRIF: "",
      KUSDRIF: "",   

      // Sovryn
      // Empty only for Mainnet
      iDOC: "",
      sovrynProtocol: "",
      sovrynPriceFeeds: "",
      sovrynLoanTokenLogicProxy: "",
      sovrynLoanTokenLogicLM: "",
    },
  },
} as const;