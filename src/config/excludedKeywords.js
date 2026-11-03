const excludedKeywords = {
  "Global": [
    "dark web", "hitman", "buy drugs online", 
    "white supremacist", "neo-nazi", "suicide methods", "sponsored post", "casino online",
  ],
  "Technology & Digital Life": [
    "ddos tutorial", "how to hack", "malware download", "ransomware source code", 
    "cracked software", "keygen", "pirated", "undress ai"
  ],
  "Business & Entrepreneurship": [
    "ponzi scheme", "pyramid scheme", "pump and dump", "unregistered securities", 
    "insider trading tips", "tax evasion tutorial", "money laundering"
  ],
  "Health & Medicine": [
    "cure cancer naturally", "vaccine microchip", "anti-vax", "bleach enema", 
    "buy prescription drugs without", "black market pharmacy"
  ],
  "Education & Learning": [
    "buy college essay", "essay mill", "test answers leak", "how to cheat exam", 
    "school shooting", "active shooter plan", "bomb threat"
  ],
  "Finance & Money": [
    "ponzi scheme", "pyramid scheme", "pump and dump", "unregistered securities", 
    "insider trading tips", "tax evasion tutorial", "money laundering", "offshore shell company", "get rich quick", "guaranteed returns"
  ],
  "Wellness & Personal Growth": [
    "cure cancer naturally", "vaccine microchip", "anti-vax", "bleach enema", "ivermectin cure",
     "buy prescription drugs without", "black market pharmacy", "tapeworm diet"
  ],
  "Relationships & Family": [
    "pickup artist tricks", "pua tactics", "how to manipulate", "gaslighting tutorial", "revenge porn", "non-consensual", "child bride", "grooming"
  ],
  "Environment & Nature": [
    "climate change hoax", "flat earth", "chemtrails", "buy ivory", "rhino horn", "exotic pet trade", "illegal logging", "poaching guide"
  ],
  "Food & Cooking": [
    "edible poison", "cooking meth", "how to make explosives", "hallucinogenic recipe", 
  ],
  "Travel & Places": [
    "sex tourism", "red light district prices", "human trafficking", "smuggling routes", "fake passport", "illegal immigration guide", "coyote cartel"
  ],
  "Sports & Athletics": [
    "illegal bookie", "match fixing", "buy steroids", "hgh online", "blood doping", "dog fighting", "cock fighting"
  ],
  "Agriculture & Rural Life": [
    "fertilizer bomb", "ammonium nitrate explosive", "ecoterrorism", "sabotage pipeline", "illegal pesticide", "poaching"
  ],
  "Industries & Services": [
    "fertilizer bomb", "ammonium nitrate explosive", "ecoterrorism", "sabotage pipeline", "illegal pesticide", "poaching"
  ],
  "Lifestyle & Home": [
    "pro-ana", "thinspo", "anorexia tips", "homemade explosives", "mustard gas recipe", "chlorine gas DIY", "illegal squatting", "squatters rights"
  ],
  "Hobbies & Interests": [
    "homemade gun", "ghost gun", "3d printed auto sear", "bump stock DIY", "lockpicking bypass", "hotwire a car", "making meth", "darknet market guide"
  ],
  "Arts, Culture & Entertainment": [
    "snuff film", "deepfake porn", "undress ai", "torrent download", "cracked torrent", "the pirate bay", "yify", "camgirl leak"
  ],
  "Literature & Writing": [
    "buy college essay", "write my paper for me", "plagiarism bypass", "turnitin hack", "anarchist cookbook", "terrorist manifesto"
  ],
  "History": [
    "holocaust hoax", "holocaust denial", "hitler was right", "slavery was beneficial", "white replacement theory", "nazi propaganda", "lost cause of the confederacy"
  ],
  "Politics & Society": [
    "race war", "day of the rope", "qanon drops", "deep state cabal", "insurrection plan", "election rigging tutorial", "assassinate", "armed militia training"
  ],
  "Religion, Philosophy & Beliefs": [
   "join isis", "suicide cult", "blood sacrifice", "extremist fatwa", "religious martyrdom", "satanic ritual abuse", "radicalization guide"
  ],
  "Science & Discovery": [
    "flat earth proof", "vaccine microchips", "5g mind control", "how to make anthrax", "synthetic virus DIY", "eugenics", "race science", "phrenology"
  ],
  "Career & Professional Life": [
    "corporate espionage tutorial", "embezzlement guide", "buy fake degree", "fake diploma maker", "sugar baby arrangements", "escort jobs", "onlyfans agency"
  ],
  "Community & Social Issues": [
    "vigilante justice", "incel uprising", "blackpill", "race riot", "ethnic cleansing", "lynch mob", "kill the rich"
  ]
};

module.exports = { excludedKeywords };