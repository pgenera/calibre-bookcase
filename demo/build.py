#!/usr/bin/env python3
"""Build the demo library: demo/library.json and a generated cover per book.

Every book here was published in 1930 or earlier, so it is in the public domain
in the United States. Covers are drawn here (no scans or modern cover art) in a
few old-binding styles; books in a series share a binding. Descriptions are
short summaries written for this demo. Each book links to a Project Gutenberg
search rather than a download.

usage: python3 demo/build.py      (rewrites demo/library.json and demo/covers/)
"""
import hashlib
import html
import json
import urllib.parse
from datetime import date, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent

# (title, authors, year, series, series_index, description)
BOOKS = [
    # Sherlock Holmes
    ("A Study in Scarlet", ["Arthur Conan Doyle"], 1887, "Sherlock Holmes", 1,
     "Dr. Watson takes rooms at 221B Baker Street with a consulting detective, and a body in an empty house in Brixton leads back to the American West."),
    ("The Sign of the Four", ["Arthur Conan Doyle"], 1890, "Sherlock Holmes", 2,
     "A young woman receives a pearl every year from an unknown sender; Holmes follows the trail to a stolen Indian treasure."),
    ("The Adventures of Sherlock Holmes", ["Arthur Conan Doyle"], 1892, "Sherlock Holmes", 3,
     "Twelve stories, among them A Scandal in Bohemia, The Red-Headed League and The Speckled Band."),
    ("The Memoirs of Sherlock Holmes", ["Arthur Conan Doyle"], 1894, "Sherlock Holmes", 4,
     "Eleven more cases, ending at the Reichenbach Falls with Professor Moriarty."),
    ("The Hound of the Baskervilles", ["Arthur Conan Doyle"], 1902, "Sherlock Holmes", 5,
     "A family legend of a spectral hound, a death on Dartmoor, and an heir who may be next."),
    ("The Return of Sherlock Holmes", ["Arthur Conan Doyle"], 1905, "Sherlock Holmes", 6,
     "Holmes comes back from the dead in The Empty House, followed by twelve new cases."),
    ("The Valley of Fear", ["Arthur Conan Doyle"], 1915, "Sherlock Holmes", 7,
     "A coded warning, a murder at a moated manor house, and a long story of a secret society in Pennsylvania coal country."),
    ("His Last Bow", ["Arthur Conan Doyle"], 1917, "Sherlock Holmes", 8,
     "Later cases, closing with Holmes out of retirement on the eve of the First World War."),
    ("The Case-Book of Sherlock Holmes", ["Arthur Conan Doyle"], 1927, "Sherlock Holmes", 9,
     "The final twelve stories."),
    # Oz
    ("The Wonderful Wizard of Oz", ["L. Frank Baum"], 1900, "Oz", 1,
     "A cyclone carries Dorothy from Kansas to Oz, where she travels the yellow brick road to the Emerald City."),
    ("The Marvelous Land of Oz", ["L. Frank Baum"], 1904, "Oz", 2,
     "Tip and a pumpkin-headed man he brought to life escape to the Emerald City, just as General Jinjur's army seizes it."),
    ("Ozma of Oz", ["L. Frank Baum"], 1907, "Oz", 3,
     "Shipwrecked with a talking hen, Dorothy lands in Ev and helps rescue its royal family from the Nome King."),
    ("Dorothy and the Wizard in Oz", ["L. Frank Baum"], 1908, "Oz", 4,
     "An earthquake drops Dorothy and the Wizard into a land of glass people beneath California."),
    ("The Road to Oz", ["L. Frank Baum"], 1909, "Oz", 5,
     "Dorothy and the Shaggy Man wander the roads toward Ozma's birthday party."),
    ("The Emerald City of Oz", ["L. Frank Baum"], 1910, "Oz", 6,
     "Dorothy brings Aunt Em and Uncle Henry to live in Oz while the Nome King plots an invasion."),
    ("The Patchwork Girl of Oz", ["L. Frank Baum"], 1913, "Oz", 7,
     "Ojo searches Oz for the ingredients of a charm to restore his uncle, with Scraps the patchwork girl."),
    ("Tik-Tok of Oz", ["L. Frank Baum"], 1914, "Oz", 8,
     "Betsy Bobbin and the clockwork Tik-Tok join a queen's march against the Nome King."),
    ("The Scarecrow of Oz", ["L. Frank Baum"], 1915, "Oz", 9,
     "Trot and Cap'n Bill are swept into Jinxland, where the Scarecrow comes to their aid."),
    ("Rinkitink in Oz", ["L. Frank Baum"], 1916, "Oz", 10,
     "Prince Inga sets out with three magic pearls to free his parents and people."),
    ("The Lost Princess of Oz", ["L. Frank Baum"], 1917, "Oz", 11,
     "Ozma disappears along with every magic tool in Oz, and search parties set out."),
    ("The Tin Woodman of Oz", ["L. Frank Baum"], 1918, "Oz", 12,
     "The Tin Woodman goes looking for the Munchkin girl he once meant to marry."),
    ("The Magic of Oz", ["L. Frank Baum"], 1919, "Oz", 13,
     "A boy who knows a transformation word plots with the Nome King against Oz."),
    ("Glinda of Oz", ["L. Frank Baum"], 1920, "Oz", 14,
     "Ozma and Dorothy try to stop a war between the Flatheads and the Skeezers."),
    # Anne
    ("Anne of Green Gables", ["L. M. Montgomery"], 1908, "Anne of Green Gables", 1,
     "The Cuthberts ask for an orphan boy to help on their Prince Edward Island farm and are sent Anne Shirley instead."),
    ("Anne of Avonlea", ["L. M. Montgomery"], 1909, "Anne of Green Gables", 2,
     "Anne, now sixteen, teaches at the Avonlea school."),
    ("Anne of the Island", ["L. M. Montgomery"], 1915, "Anne of Green Gables", 3,
     "Anne goes to college in Kingsport."),
    ("Anne's House of Dreams", ["L. M. Montgomery"], 1917, "Anne of Green Gables", 5,
     "Anne and Gilbert begin married life in a small house at Four Winds Harbour."),
    ("Rainbow Valley", ["L. M. Montgomery"], 1919, "Anne of Green Gables", 7,
     "Anne's children and the motherless children of the new minister share a hollow they call Rainbow Valley."),
    ("Rilla of Ingleside", ["L. M. Montgomery"], 1921, "Anne of Green Gables", 8,
     "Anne's youngest daughter comes of age on the home front during the First World War."),
    # Little Women
    ("Little Women", ["Louisa May Alcott"], 1868, "Little Women", 1,
     "The four March sisters grow up in Massachusetts while their father serves in the Civil War."),
    ("Little Men", ["Louisa May Alcott"], 1871, "Little Women", 2,
     "Jo and her husband run Plumfield, a school for boys."),
    ("Jo's Boys", ["Louisa May Alcott"], 1886, "Little Women", 3,
     "The Plumfield boys, grown up and scattered."),
    # Alice
    ("Alice's Adventures in Wonderland", ["Lewis Carroll"], 1865, "Alice", 1,
     "Alice follows a White Rabbit down a rabbit hole."),
    ("Through the Looking-Glass", ["Lewis Carroll"], 1871, "Alice", 2,
     "Alice steps through a mirror into a world laid out like a chessboard."),
    # Tom and Huck
    ("The Adventures of Tom Sawyer", ["Mark Twain"], 1876, "Tom Sawyer & Huckleberry Finn", 1,
     "A boyhood on the Mississippi: fence-painting, a buried treasure, and a murder witnessed in a graveyard."),
    ("Adventures of Huckleberry Finn", ["Mark Twain"], 1884, "Tom Sawyer & Huckleberry Finn", 2,
     "Huck escapes his father and travels down the Mississippi on a raft with Jim, who is fleeing slavery."),
    # Leatherstocking
    ("The Deerslayer", ["James Fenimore Cooper"], 1841, "Leatherstocking Tales", 1,
     "Natty Bumppo's first adventure, on a New York lake during the French and Indian War."),
    ("The Last of the Mohicans", ["James Fenimore Cooper"], 1826, "Leatherstocking Tales", 2,
     "Hawkeye and his Mohican friends guide two sisters through the wilderness around Fort William Henry."),
    ("The Pathfinder", ["James Fenimore Cooper"], 1840, "Leatherstocking Tales", 3,
     "Natty Bumppo on Lake Ontario, and in love."),
    ("The Pioneers", ["James Fenimore Cooper"], 1823, "Leatherstocking Tales", 4,
     "An older Natty Bumppo clashes with the settlers of Templeton."),
    ("The Prairie", ["James Fenimore Cooper"], 1827, "Leatherstocking Tales", 5,
     "Natty Bumppo's last days, on the Great Plains."),
    # d'Artagnan
    ("The Three Musketeers", ["Alexandre Dumas"], 1844, "The d'Artagnan Romances", 1,
     "D'Artagnan comes to Paris and falls in with Athos, Porthos and Aramis against Cardinal Richelieu."),
    ("Twenty Years After", ["Alexandre Dumas"], 1845, "The d'Artagnan Romances", 2,
     "The musketeers reunite during the Fronde and the English Civil War."),
    ("The Vicomte of Bragelonne", ["Alexandre Dumas"], 1847, "The d'Artagnan Romances", 3,
     "The last of the romances, including the story of the Man in the Iron Mask."),
    # Barsoom
    ("A Princess of Mars", ["Edgar Rice Burroughs"], 1917, "Barsoom", 1,
     "Confederate veteran John Carter wakes on Mars and fights for the princess Dejah Thoris."),
    ("The Gods of Mars", ["Edgar Rice Burroughs"], 1918, "Barsoom", 2,
     "John Carter returns to Mars and exposes the religion of the River Iss."),
    ("The Warlord of Mars", ["Edgar Rice Burroughs"], 1919, "Barsoom", 3,
     "John Carter pursues Dejah Thoris's kidnappers to the north pole of Mars."),
    ("Thuvia, Maid of Mars", ["Edgar Rice Burroughs"], 1920, "Barsoom", 4,
     "John Carter's son Carthoris and the princess Thuvia."),
    ("The Chessmen of Mars", ["Edgar Rice Burroughs"], 1922, "Barsoom", 5,
     "Tara of Helium is captured, and played for, in a game of living chess."),
    ("The Master Mind of Mars", ["Edgar Rice Burroughs"], 1928, "Barsoom", 6,
     "An Earthman apprenticed to a Martian surgeon who transplants brains."),
    # Tarzan
    ("Tarzan of the Apes", ["Edgar Rice Burroughs"], 1914, "Tarzan", 1,
     "An English lord's orphaned son is raised by apes in the African jungle."),
    ("The Return of Tarzan", ["Edgar Rice Burroughs"], 1915, "Tarzan", 2,
     "Tarzan tries civilization in Paris and North Africa, then returns to the jungle."),
    ("The Beasts of Tarzan", ["Edgar Rice Burroughs"], 1916, "Tarzan", 3,
     "Tarzan raises a band of animals to rescue his wife and son."),
    ("The Son of Tarzan", ["Edgar Rice Burroughs"], 1917, "Tarzan", 4,
     "Tarzan's son runs away to Africa."),
    ("Tarzan and the Jewels of Opar", ["Edgar Rice Burroughs"], 1918, "Tarzan", 5,
     "A blow to the head leaves Tarzan without his memory in the lost city of Opar."),
    # Poirot, Tommy and Tuppence, Marple
    ("The Mysterious Affair at Styles", ["Agatha Christie"], 1920, "Hercule Poirot", 1,
     "A wealthy widow is poisoned in an Essex country house, and a Belgian refugee detective investigates."),
    ("The Murder on the Links", ["Agatha Christie"], 1923, "Hercule Poirot", 2,
     "Poirot answers a call for help and finds the man who sent it dead on a French golf course."),
    ("Poirot Investigates", ["Agatha Christie"], 1924, "Hercule Poirot", 3,
     "Eleven short cases."),
    ("The Murder of Roger Ackroyd", ["Agatha Christie"], 1926, "Hercule Poirot", 4,
     "Poirot, retired to grow marrows, is drawn into a village murder."),
    ("The Big Four", ["Agatha Christie"], 1927, "Hercule Poirot", 5,
     "Poirot against an international criminal organization."),
    ("The Mystery of the Blue Train", ["Agatha Christie"], 1928, "Hercule Poirot", 6,
     "An heiress is murdered on the train to the Riviera."),
    ("The Secret Adversary", ["Agatha Christie"], 1922, "Tommy and Tuppence", 1,
     "Two young friends start a business as adventurers and are soon hunting for a missing treaty."),
    ("The Murder at the Vicarage", ["Agatha Christie"], 1930, "Miss Marple", 1,
     "A disliked colonel is shot in the vicar's study at St. Mary Mead."),
    # Father Brown
    ("The Innocence of Father Brown", ["G. K. Chesterton"], 1911, "Father Brown", 1,
     "The first stories of the unassuming priest who solves crimes by understanding sin."),
    ("The Wisdom of Father Brown", ["G. K. Chesterton"], 1914, "Father Brown", 2,
     "Twelve more stories."),
    ("The Incredulity of Father Brown", ["G. K. Chesterton"], 1926, "Father Brown", 3,
     "Father Brown faces crimes that seem to have supernatural causes."),
    ("The Secret of Father Brown", ["G. K. Chesterton"], 1927, "Father Brown", 4,
     "Father Brown explains his method."),
    # Hannay
    ("The Thirty-Nine Steps", ["John Buchan"], 1915, "Richard Hannay", 1,
     "Richard Hannay is framed for murder and flees across Scotland with a dead man's notebook."),
    ("Greenmantle", ["John Buchan"], 1916, "Richard Hannay", 2,
     "Hannay crosses wartime Europe to Constantinople."),
    ("Mr Standfast", ["John Buchan"], 1919, "Richard Hannay", 3,
     "Hannay goes undercover among pacifists to find a German spy."),
    ("The Three Hostages", ["John Buchan"], 1924, "Richard Hannay", 4,
     "Hannay searches for three hostages held by a criminal mastermind."),
    # Jeeves
    ("My Man Jeeves", ["P. G. Wodehouse"], 1919, "Jeeves", 1,
     "The first stories of Bertie Wooster and his valet."),
    ("The Inimitable Jeeves", ["P. G. Wodehouse"], 1923, "Jeeves", 2,
     "Bertie's friend Bingo Little falls in love, repeatedly."),
    ("Carry On, Jeeves", ["P. G. Wodehouse"], 1925, "Jeeves", 3,
     "Ten stories, including how Jeeves came to work for Bertie."),
    ("Very Good, Jeeves!", ["P. G. Wodehouse"], 1930, "Jeeves", 4,
     "Eleven more stories."),
    # Winnie-the-Pooh
    ("Winnie-the-Pooh", ["A. A. Milne"], 1926, "Winnie-the-Pooh", 1,
     "Christopher Robin's bear and his friends in the Hundred Acre Wood."),
    ("The House at Pooh Corner", ["A. A. Milne"], 1928, "Winnie-the-Pooh", 2,
     "Tigger arrives, and Christopher Robin prepares to go away."),
    # Standalones
    ("Pride and Prejudice", ["Jane Austen"], 1813, None, None,
     "Elizabeth Bennet and Mr. Darcy get off on the wrong foot."),
    ("Sense and Sensibility", ["Jane Austen"], 1811, None, None,
     "The Dashwood sisters, one prudent and one passionate, in love and short of money."),
    ("Emma", ["Jane Austen"], 1815, None, None,
     "A young woman who considers herself a fine matchmaker."),
    ("Persuasion", ["Jane Austen"], 1817, None, None,
     "Anne Elliot meets again the naval officer she was persuaded not to marry."),
    ("Northanger Abbey", ["Jane Austen"], 1817, None, None,
     "A reader of Gothic novels visits an abbey and imagines the worst."),
    ("Mansfield Park", ["Jane Austen"], 1814, None, None,
     "Fanny Price grows up as the poor relation in her uncle's house."),
    ("Frankenstein", ["Mary Shelley"], 1818, None, None,
     "A young scientist creates a living being and abandons it."),
    ("Dracula", ["Bram Stoker"], 1897, None, None,
     "Told in letters and diaries: a Transylvanian count comes to England."),
    ("Moby-Dick", ["Herman Melville"], 1851, None, None,
     "Ishmael ships aboard the Pequod, whose captain is hunting one white whale."),
    ("Jane Eyre", ["Charlotte Brontë"], 1847, None, None,
     "An orphaned governess and her employer, Mr. Rochester, who has a secret."),
    ("Wuthering Heights", ["Emily Brontë"], 1847, None, None,
     "Catherine Earnshaw and Heathcliff on the Yorkshire moors, and the wreckage they leave."),
    ("Great Expectations", ["Charles Dickens"], 1861, None, None,
     "Pip, an orphan, is raised to be a gentleman by an unknown benefactor."),
    ("A Tale of Two Cities", ["Charles Dickens"], 1859, None, None,
     "London and Paris before and during the French Revolution."),
    ("Bleak House", ["Charles Dickens"], 1853, None, None,
     "An endless lawsuit in Chancery, and the lives tangled in it."),
    ("Oliver Twist", ["Charles Dickens"], 1838, None, None,
     "A workhouse orphan falls in with Fagin's gang of London pickpockets."),
    ("David Copperfield", ["Charles Dickens"], 1850, None, None,
     "A life told from childhood, with Mr. Micawber, Uriah Heep and Betsey Trotwood."),
    ("A Christmas Carol", ["Charles Dickens"], 1843, None, None,
     "Three spirits visit Ebenezer Scrooge on Christmas Eve."),
    ("The Time Machine", ["H. G. Wells"], 1895, None, None,
     "A Victorian inventor travels to the year 802,701."),
    ("The War of the Worlds", ["H. G. Wells"], 1898, None, None,
     "Martians land in Surrey."),
    ("The Invisible Man", ["H. G. Wells"], 1897, None, None,
     "A scientist makes himself invisible and cannot undo it."),
    ("The Island of Doctor Moreau", ["H. G. Wells"], 1896, None, None,
     "A shipwrecked man reaches an island where a vivisectionist works on animals."),
    ("Twenty Thousand Leagues Under the Seas", ["Jules Verne"], 1870, None, None,
     "A naturalist becomes a captive aboard Captain Nemo's submarine, the Nautilus."),
    ("Around the World in Eighty Days", ["Jules Verne"], 1872, None, None,
     "Phileas Fogg wagers that he can circle the globe in eighty days."),
    ("Journey to the Centre of the Earth", ["Jules Verne"], 1864, None, None,
     "A professor and his nephew descend through an Icelandic volcano."),
    ("Treasure Island", ["Robert Louis Stevenson"], 1883, None, None,
     "Jim Hawkins, a treasure map, and Long John Silver."),
    ("Strange Case of Dr Jekyll and Mr Hyde", ["Robert Louis Stevenson"], 1886, None, None,
     "A London lawyer looks into his friend's connection to a violent man."),
    ("Kidnapped", ["Robert Louis Stevenson"], 1886, None, None,
     "David Balfour is sold onto a ship by his uncle and escapes across the Highlands with Alan Breck."),
    ("The Picture of Dorian Gray", ["Oscar Wilde"], 1890, None, None,
     "A portrait ages while the young man it depicts does not."),
    ("Tess of the d'Urbervilles", ["Thomas Hardy"], 1891, None, None,
     "A poor girl learns her family descends from nobility."),
    ("Far from the Madding Crowd", ["Thomas Hardy"], 1874, None, None,
     "Bathsheba Everdene, a farmer, and three very different suitors."),
    ("Jude the Obscure", ["Thomas Hardy"], 1895, None, None,
     "A stonemason dreams of the university at Christminster."),
    ("Middlemarch", ["George Eliot"], 1871, None, None,
     "A study of provincial life, centred on Dorothea Brooke and the doctor Tertius Lydgate."),
    ("War and Peace", ["Leo Tolstoy"], 1869, None, None,
     "Russian families through the Napoleonic Wars."),
    ("Anna Karenina", ["Leo Tolstoy"], 1878, None, None,
     "A married woman's affair with an officer, alongside Levin's search for meaning on his estate."),
    ("Crime and Punishment", ["Fyodor Dostoevsky"], 1866, None, None,
     "A former student in St. Petersburg commits a murder and lives with it."),
    ("The Brothers Karamazov", ["Fyodor Dostoevsky"], 1880, None, None,
     "Three brothers and the murder of their father."),
    ("Madame Bovary", ["Gustave Flaubert"], 1857, None, None,
     "A doctor's wife in provincial Normandy longs for the life in her novels."),
    ("Les Misérables", ["Victor Hugo"], 1862, None, None,
     "Jean Valjean, a released convict, is pursued for decades by the inspector Javert."),
    ("The Great Gatsby", ["F. Scott Fitzgerald"], 1925, None, None,
     "Nick Carraway's neighbour on Long Island throws parties for one guest who never comes."),
    ("This Side of Paradise", ["F. Scott Fitzgerald"], 1920, None, None,
     "Amory Blaine at Princeton and after."),
    ("The Sun Also Rises", ["Ernest Hemingway"], 1926, None, None,
     "Expatriates travel from Paris to the bullfights at Pamplona."),
    ("A Farewell to Arms", ["Ernest Hemingway"], 1929, None, None,
     "An American ambulance driver on the Italian front and an English nurse."),
    ("Mrs Dalloway", ["Virginia Woolf"], 1925, None, None,
     "One June day in London as Clarissa Dalloway prepares for a party."),
    ("To the Lighthouse", ["Virginia Woolf"], 1927, None, None,
     "The Ramsay family's summers on the Isle of Skye, before and after the war."),
    ("Orlando", ["Virginia Woolf"], 1928, None, None,
     "A biography of a poet who lives for centuries and changes sex."),
    ("Dubliners", ["James Joyce"], 1914, None, None,
     "Fifteen stories of Dublin life, ending with The Dead."),
    ("Ulysses", ["James Joyce"], 1922, None, None,
     "One day in Dublin, 16 June 1904, following Leopold Bloom."),
    ("The Age of Innocence", ["Edith Wharton"], 1920, None, None,
     "A New York lawyer engaged to a suitable bride falls for her unconventional cousin."),
    ("The House of Mirth", ["Edith Wharton"], 1905, None, None,
     "Lily Bart, beautiful and unmarried, in New York society."),
    ("Ethan Frome", ["Edith Wharton"], 1911, None, None,
     "A Massachusetts farmer, his ailing wife, and her young cousin."),
    ("My Ántonia", ["Willa Cather"], 1918, None, None,
     "A Bohemian immigrant girl on the Nebraska prairie, remembered by a friend."),
    ("O Pioneers!", ["Willa Cather"], 1913, None, None,
     "Alexandra Bergson holds her family's Nebraska farm together."),
    ("Heart of Darkness", ["Joseph Conrad"], 1899, None, None,
     "Marlow travels up the Congo River in search of the ivory trader Kurtz."),
    ("Lord Jim", ["Joseph Conrad"], 1900, None, None,
     "A young mate abandons his ship and spends his life trying to make up for it."),
    ("A Room with a View", ["E. M. Forster"], 1908, None, None,
     "Lucy Honeychurch in Florence, and the choice that follows her home."),
    ("Howards End", ["E. M. Forster"], 1910, None, None,
     "The Schlegel sisters, the Wilcoxes, and who will inherit a house."),
    ("A Passage to India", ["E. M. Forster"], 1924, None, None,
     "An incident in the Marabar Caves divides the English and Indians of Chandrapore."),
    ("Main Street", ["Sinclair Lewis"], 1920, None, None,
     "A city-bred young woman marries a doctor and tries to reform a Minnesota town."),
    ("Babbitt", ["Sinclair Lewis"], 1922, None, None,
     "A prosperous real-estate agent in Zenith begins to doubt his life."),
    ("Red Harvest", ["Dashiell Hammett"], 1929, None, None,
     "The Continental Op sets a corrupt mining town's gangs against each other."),
    ("The Maltese Falcon", ["Dashiell Hammett"], 1930, None, None,
     "Sam Spade's partner is shot, and everyone wants a black statuette."),
    ("The Jungle Book", ["Rudyard Kipling"], 1894, None, None,
     "Mowgli is raised by wolves; with Rikki-Tikki-Tavi and other stories."),
    ("Kim", ["Rudyard Kipling"], 1901, None, None,
     "An Irish orphan in Lahore becomes a lama's disciple and a spy."),
    ("The Secret Garden", ["Frances Hodgson Burnett"], 1911, None, None,
     "Mary Lennox, sent to a Yorkshire manor, finds a locked garden."),
    ("A Little Princess", ["Frances Hodgson Burnett"], 1905, None, None,
     "A rich pupil at a London boarding school loses everything."),
    ("Peter and Wendy", ["J. M. Barrie"], 1911, None, None,
     "Peter Pan takes the Darling children to Neverland."),
    ("The Wind in the Willows", ["Kenneth Grahame"], 1908, None, None,
     "Mole, Rat, Badger and the reckless Mr. Toad."),
    ("The Railway Children", ["E. Nesbit"], 1906, None, None,
     "Three children move to the country after their father is taken away."),
    ("The Call of the Wild", ["Jack London"], 1903, None, None,
     "Buck, a stolen dog, is put to work in the Klondike."),
    ("White Fang", ["Jack London"], 1906, None, None,
     "A wolf-dog's journey from the wild to domestication."),
    ("Captain Blood", ["Rafael Sabatini"], 1922, None, None,
     "An Irish doctor transported to Barbados becomes a pirate."),
    ("Scaramouche", ["Rafael Sabatini"], 1921, None, None,
     "A lawyer turned actor and swordsman in the French Revolution."),
    ("The Phantom of the Opera", ["Gaston Leroux"], 1910, None, None,
     "A masked figure haunts the Paris Opera and a young soprano."),
    ("The Sound and the Fury", ["William Faulkner"], 1929, None, None,
     "The decline of the Compson family, told by four narrators."),
]

# Bookcloth colours, each with a lighter ink, for the bindings.
CLOTHS = [("#6d2027", "#efe1c6"), ("#2f4a35", "#e9dfc4"), ("#22324f", "#e6dcc2"), ("#8c4a2b", "#f1e3c8"),
          ("#2d5d63", "#ecdfc2"), ("#4f2d4a", "#eadcc4"), ("#4b5560", "#ede2c9"), ("#5c5a2e", "#efe4c6"),
          ("#a3763a", "#2a1d10"), ("#c8b48a", "#3a2a1a"), ("#7a2e3a", "#f0dfc0"), ("#304040", "#e8dcc0")]
GOLD = "#d1ac58"
W, H = 300, 450
SERIF = "Georgia, 'Times New Roman', serif"


def pick(key, n):
    return int(hashlib.sha256(key.encode()).hexdigest(), 16) % n


def wrap(text, size, width):
    """Greedy line wrap using an average serif glyph width."""
    per_line = max(6, int(width / (size * 0.52)))
    lines, line = [], ''
    for word in text.split():
        trial = f'{line} {word}'.strip()
        if len(trial) <= per_line or not line:
            line = trial
        else:
            lines.append(line)
            line = word
    lines.append(line)
    return lines


def title_block(title, x, y, color, width=230, italic=False):
    size = 40 if len(title) <= 14 else 34 if len(title) <= 26 else 28 if len(title) <= 40 else 24
    lines = wrap(title, size, width)
    while len(lines) > 4 and size > 18:
        size -= 2
        lines = wrap(title, size, width)
    lh = size * 1.12
    top = y - (len(lines) - 1) * lh / 2
    style = ' font-style="italic"' if italic else ''
    out = ''.join(f'<text x="{x}" y="{top + i * lh:.1f}" font-size="{size}"{style} text-anchor="middle" '
                  f'fill="{color}" font-family="{SERIF}">{html.escape(t)}</text>' for i, t in enumerate(lines))
    return out


def small(text, x, y, color, size=17, italic=False, spacing=0):
    style = ' font-style="italic"' if italic else ''
    ls = f' letter-spacing="{spacing}"' if spacing else ''
    return (f'<text x="{x}" y="{y}" font-size="{size}"{style}{ls} text-anchor="middle" fill="{color}" '
            f'font-family="{SERIF}">{html.escape(text)}</text>')


def diamond(x, y, r, color):
    return f'<path d="M{x} {y - r} L{x + r} {y} L{x} {y + r} L{x - r} {y} Z" fill="{color}"/>'


def cover(book):
    title, authors, year, series, idx, _ = book
    key = series or authors[0]
    cloth, ink = CLOTHS[pick(key, len(CLOTHS))]
    style = pick(key + '/style', 3)
    author = ' & '.join(authors)
    gold = GOLD if ink.startswith('#e') or ink.startswith('#f') else ink
    parts = [f'<rect width="{W}" height="{H}" fill="{cloth}"/>',
             # a faint cloth grain
             f'<rect width="{W}" height="{H}" fill="url(#grain)" opacity="0.18"/>']
    if style == 0:      # double gilt frame
        parts += [f'<rect x="16" y="16" width="{W - 32}" height="{H - 32}" fill="none" stroke="{gold}" stroke-width="2"/>',
                  f'<rect x="24" y="24" width="{W - 48}" height="{H - 48}" fill="none" stroke="{gold}" stroke-width="0.8"/>',
                  title_block(title, W / 2, 168, ink),
                  diamond(W / 2, 262, 6, gold),
                  small(author, W / 2, 318, ink, 19, italic=True)]
    elif style == 1:    # a pasted paper label
        parts += [f'<rect x="38" y="92" width="{W - 76}" height="210" fill="#efe6cf" stroke="{gold}" stroke-width="1.5"/>',
                  f'<rect x="46" y="100" width="{W - 92}" height="194" fill="none" stroke="#5b4a33" stroke-width="0.7"/>',
                  title_block(title, W / 2, 178, '#2a2017', width=190),
                  small(author, W / 2, 272, '#5b4a33', 17, italic=True)]
    else:               # bands
        parts += [f'<rect x="0" y="54" width="{W}" height="4" fill="{gold}"/>',
                  f'<rect x="0" y="{H - 58}" width="{W}" height="4" fill="{gold}"/>',
                  title_block(title, W / 2, 190, ink, italic=True),
                  f'<line x1="110" y1="282" x2="190" y2="282" stroke="{gold}" stroke-width="1.2"/>',
                  small(author, W / 2, 322, ink, 19)]
    if series:
        parts.append(small(f'{series}', W / 2, H - 70 if style != 2 else H - 82, ink, 13, spacing=1))
        if idx:
            parts.append(small(f'{idx}', W / 2, H - 46 if style != 2 else H - 26, gold, 15))
    else:
        parts.append(small(str(year), W / 2, H - 52 if style != 2 else H - 26, gold, 14, spacing=2))
    defs = ('<defs><pattern id="grain" width="4" height="4" patternUnits="userSpaceOnUse">'
            '<path d="M0 4 L4 0" stroke="#000" stroke-width="0.6"/></pattern></defs>')
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">'
            + defs + ''.join(parts) + '</svg>\n')


def author_sort(name):
    parts = name.split()
    return f'{parts[-1]}, {" ".join(parts[:-1])}'


def main():
    covers = HERE / 'covers'
    covers.mkdir(exist_ok=True)
    for old in covers.glob('*.svg'):
        old.unlink()
    books = []
    # "Date added": spread over the past year in a fixed shuffled order, so the
    # newest-first view has something to show.
    start = date(2025, 10, 1)
    order = sorted(range(len(BOOKS)), key=lambda k: hashlib.sha256(BOOKS[k][0].encode()).hexdigest())
    added = {k: start + timedelta(days=int(n * 365 / len(BOOKS))) for n, k in enumerate(order)}
    for k, book in enumerate(BOOKS):
        bid = k + 1
        title, authors, year, series, idx, desc = book
        (covers / f'{bid}.svg').write_text(cover(book))
        query = urllib.parse.quote_plus(f'{title} {authors[0]}')
        books.append({
            'id': bid, 'title': title, 'authors': authors,
            'author_sort': ' & '.join(author_sort(a) for a in authors),
            'series': series, 'series_index': idx, 'pubdate': f'{year}-01-01',
            'added': f'{added[k].isoformat()}T12:00:00+00:00',
            'comments': f'<p>{html.escape(desc)}</p>',
            'links': [{'text': 'Find it at Project Gutenberg',
                       'href': f'https://www.gutenberg.org/ebooks/search/?query={query}'}],
        })
    library = {
        'name': 'Public-domain demo',
        'home': 'https://github.com/pgenera/calibre-bookcase',
        'books': books,
    }
    (HERE / 'library.json').write_text(json.dumps(library, ensure_ascii=False, indent=1) + '\n')
    print(f'{len(books)} books, {len(list(covers.glob("*.svg")))} covers')


if __name__ == '__main__':
    main()
