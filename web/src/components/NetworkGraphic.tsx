export function NetworkGraphic() {
  return <div className="network-graphic" aria-hidden="true"><svg viewBox="0 0 520 236" fill="none">
    <defs><radialGradient id="network-glow"><stop stopColor="#42ae7d" stopOpacity=".2" /><stop offset="1" stopColor="#42ae7d" stopOpacity="0" /></radialGradient><linearGradient id="network-path" x1="85" y1="50" x2="440" y2="190" gradientUnits="userSpaceOnUse"><stop stopColor="#6ccca2" stopOpacity=".08" /><stop offset=".5" stopColor="#95e9b9" stopOpacity=".7" /><stop offset="1" stopColor="#6ccca2" stopOpacity=".15" /></linearGradient><pattern id="network-grid" width="28" height="28" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r=".8" fill="#a0dfb9" opacity=".18" /></pattern><filter id="node-glow"><feGaussianBlur stdDeviation="4" /></filter></defs>
    <rect width="520" height="236" fill="url(#network-grid)" /><ellipse cx="290" cy="120" rx="220" ry="130" fill="url(#network-glow)" />
    <ellipse cx="286" cy="119" rx="181" ry="91" stroke="#8bd3aa" strokeOpacity=".13" transform="rotate(-13 286 119)" />
    <ellipse cx="286" cy="119" rx="127" ry="64" stroke="#8bd3aa" strokeOpacity=".2" strokeDasharray="3 6" transform="rotate(-13 286 119)" />
    <ellipse cx="286" cy="119" rx="72" ry="36" stroke="#8bd3aa" strokeOpacity=".12" transform="rotate(-13 286 119)" />
    <path d="m112 94 84-45 91 70 88-78 72 86-75 72-85-80-97 67-78-92Z" stroke="url(#network-path)" />
    <path d="m112 94 175 25 160 8M196 49l-6 137m185-145-3 158" stroke="#77c99b" strokeOpacity=".23" strokeDasharray="4 5" />
    <path d="m190 186 97-67 85 80M196 49l91 70 88-78" stroke="#9be5b6" strokeOpacity=".5" />
    <circle cx="287" cy="119" r="45" fill="#5ca77c" fillOpacity=".07" stroke="#93daa8" strokeOpacity=".15" /><circle cx="287" cy="119" r="35" fill="#6bbd8d" fillOpacity=".12" />
    <rect x="260" y="92" width="54" height="54" rx="16" fill="#bce8a8" /><path d="M270 120h9l5-13 8 26 5-13h8" stroke="#15543d" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" />
    {[[112,94],[196,49],[375,41],[447,127],[372,199],[190,186]].map(([x,y], index) => <g key={index}><circle cx={x} cy={y} r="13" fill="#8bdda7" opacity=".09" /><circle cx={x} cy={y} r="7" fill="#294f3d" stroke="#70bc8c" strokeOpacity=".7" /><circle cx={x} cy={y} r="2.8" fill="#b2e7b3" /></g>)}
    <circle cx="231" cy="80" r="2" fill="#d1f9bc" /><circle cx="354" cy="161" r="2" fill="#d1f9bc" /><circle cx="153" cy="141" r="2" fill="#a2d6a6" />
    <rect x="320" y="65" width="132" height="29" rx="7" fill="#254f3d" stroke="#689c76" strokeOpacity=".35" /><circle cx="333" cy="79.5" r="3" fill="#b7e79d" /><text x="343" y="83" fill="#dfefde" fontSize="10" fontFamily="Golos Text, sans-serif">Связь имеет значение</text>
    <rect x="95" y="158" width="120" height="29" rx="7" fill="#214837" stroke="#689c76" strokeOpacity=".3" /><path d="M107 169h7m-7 4h7m-7 4h4" stroke="#acdba9" strokeWidth="1.2" strokeLinecap="round" /><text x="122" y="176" fill="#dfefde" fontSize="10" fontFamily="Golos Text, sans-serif">75 точек проверки</text>
    <text x="428" y="217" fill="#8eb89a" fillOpacity=".7" fontSize="8" letterSpacing="2" fontFamily="Golos Text, sans-serif">PULSE / NET</text>
  </svg></div>
}
