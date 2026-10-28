// PBAT DOOR TO DOOR: doorstep toolkit shown in the volunteer area (works offline).
// ➜ DRAFT for approval. Edit the text inside the quotes. Keep every figure tied to a dated source,
//   the same ones used on the "His works" section of the home page.

export const APPROVED = false;   // set to true once the movement has approved this content

export const TALKING_POINTS = [
  { title: 'Students can now study on a loan',
    text: 'Through NELFUND, ₦242.4 billion has reached 1,388,592 students in 288 institutions (to April 2026).' },
  { title: 'Workers earn more',
    text: 'The national minimum wage went from ₦30,000 to ₦70,000 in July 2024, and is now reviewed every three years.' },
  { title: 'Fairer taxes',
    text: 'Four new tax laws, in force from January 2026, give relief to low-income earners, families and small businesses.' },
  { title: 'Roads that link the country',
    text: 'The Lagos–Calabar Coastal Highway (750 km, 9 states) has opened its first stretch, and 81 km of the Abuja–Kaduna–Zaria–Kano road is open.' },
  { title: 'The economy is growing',
    text: 'GDP grew 4.43% in Q2 2026, and ₦5.41 trillion is going into security in the 2026 budget.' },
];

export const FACT_SHEET = [
  { area: 'Education', facts: [
    ['1,388,592 students funded', '₦242.4 billion in fees and upkeep through NELFUND, in 288 tertiary institutions, to 15 April 2026.',
      'THISDAY, April 2026', 'https://www.thisdaylive.com/2026/04/20/nelfund-loan-disbursement-hits-n242-4bn-with-1-38m-beneficiaries/'],
  ] },
  { area: 'Workers and families', facts: [
    ['₦70,000 minimum wage', 'Signed into law in July 2024, up from ₦30,000. Reviews now every three years instead of five.',
      'THISDAY, July 2024', 'https://www.thisdaylive.com/2024/07/30/tinubu-signs-n70000-minimum-wage-bill-into-law-amid-unease-over-planned-protest/'],
    ['Four new tax laws', 'Signed June 2025, in force January 2026: one simpler system, with relief for low-income earners, families and small businesses.',
      'NAN, June 2025', 'https://nannews.ng/2025/06/26/tinubu-signs-4-tax-reform-bills-into-law'],
  ] },
  { area: 'Economy', facts: [
    ['Fuel subsidy ended', 'Announced in the inaugural address on 29 May 2023.',
      'Inaugural address (full video), Channels TV', 'https://www.channelstv.com/2023/05/29/full-video-president-tinubus-inaugural-speech'],
    ['One exchange rate', 'Multiple exchange-rate windows merged into one market in June 2023; the $7bn+ FX backlog cleared.',
      'THISDAY, May 2026', 'https://www.thisdaylive.com/2026/05/30/three-years-of-tinubu-four-successes-four-failures/'],
    ['4.43% GDP growth', 'Real GDP growth in Q2 2026, up from 4.23% a year earlier (figures cited by the State House).',
      'The Authority, Sept 2026', 'https://authorityngr.com/2026/09/24/2027-what-achievements-will-president-tinubu-be-campaigning-on/'],
  ] },
  { area: 'Roads', facts: [
    ['Lagos–Calabar Coastal Highway', '750 km through 9 states; the first 30 km opened to traffic in December 2025.',
      'Federal Ministry of Information', 'https://fmino.gov.ng/fg-temporarily-opens-completed-stretch-of-lagos-calabar-coastal-highway-to-traffic/'],
    ['Abuja–Kaduna–Zaria–Kano road', 'An 81-km section inaugurated in Kaduna on 24 October 2026.',
      'allAfrica, October 2026', 'https://allafrica.com/stories/202610260027.html'],
  ] },
  { area: 'Security', facts: [
    ['₦5.41 trillion for security', 'Allocated to defence and security in the 2026 budget, with more than 50,000 new police officers being recruited.',
      'The Authority, Sept 2026', 'https://authorityngr.com/2026/09/24/2027-what-achievements-will-president-tinubu-be-campaigning-on/'],
  ] },
];

// Honest answers to the hard questions. Listen first; never argue or promise what isn't on this page.
export const HARD_QUESTIONS = [
  { q: '"Prices are too high. Food and transport cost too much."',
    a: "Agree that it has been hard: don't deny it. Explain that removing the fuel subsidy and unifying the exchange rate were painful but meant to stop money leaking out of the economy. Point to what has reached ordinary people since: the ₦70,000 minimum wage, student loans for over 1.3 million students, and tax relief for low-income earners from January 2026. Ask which of these matters most to their household." },
  { q: '"Why did he remove the fuel subsidy?"',
    a: "He announced it on his first day (29 May 2023). The government's case is that the subsidy took money that should go to roads, schools and security. Be honest that pump prices went up. Say the savings are meant to fund programmes like the student loans and the coastal highway. (Coordinators: add a sourced figure for the subsidy's cost before using this widely.)" },
  { q: '"What about insecurity?"',
    a: "Take it seriously and let them speak. Share that ₦5.41 trillion is going into defence and security in the 2026 budget and more than 50,000 new police officers are being recruited. Don't claim any area is now safe; say the work is ongoing." },
  { q: '"Nothing has changed for me."',
    a: 'Listen and ask what they need most: school fees, wages, roads, business. Then share the one fact from the toolkit that fits (student loans, minimum wage, tax relief, roads). One relevant fact beats five general ones.' },
  { q: '"My vote doesn\'t count."',
    a: 'Votes are counted at each polling unit, in front of the voters there. Encourage them to check their registration, collect their PVC and know their polling unit, whoever they vote for. Offer to help them find their polling unit.' },
  { q: '"Are you being paid to say this?"',
    a: "Be honest: say you're a volunteer with the PBAT Door to Door Movement and why you chose to join. Never offer money, gifts or favours for support." },
];

export const CONDUCT = [
  'Be respectful and peaceful at every door. Never use threats, insults, bribes or pressure.',
  "Only share facts from this toolkit or the His works section, and say where they're from.",
  "If you don't know an answer, say so and offer to find out. Don't guess.",
  'Only record a pledge if the person clearly agrees. Never share their details outside the movement.',
  "Don't present yourself as an official of the government, INEC or any security agency.",
  'Leave politely when asked. Never argue on a doorstep.',
];

export const VOTER_BASICS = [
  ['Check registration', "Check your voter registration on INEC's official portal.", 'https://cvr.inecnigeria.org'],
  ['Collect your PVC', 'Collect your Permanent Voter Card from your local INEC office or designated centre when INEC announces collection dates.', 'https://inecnigeria.org'],
  ['Know your polling unit', 'Your polling unit is printed on your voter card. You can also find it in your profile on this site.', '/account'],
];
