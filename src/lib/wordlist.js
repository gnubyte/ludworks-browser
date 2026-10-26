// Bundled passphrase word list (Ludworks, original compilation).
// 3321 unique lowercase words, 3–9 letters a–z, sorted. log2(3321) ≈ 11.70 bits per word.
// Regenerate only with care: changing the list changes passphrase entropy estimates (tests assert >= 2048 words).

const RAW = `
aardvark abbey able about above absent absorb abstract academy accent accept access accordion
account achieve acid acorn acre across act action active actor actual adapt add address adjust
admire admit adopt adore adult advance adventure advice aerial afford after again age agency agenda
agent agile agree ahead aid aim air airline airplane airport airy aisle alarm albatross album alert
algebra align alike alive alley alligator allow almond alone alpaca alpha alpine already also alter
always amaze amazing amber amble amount ample amuse anagram anchor anchovy ancient angle angora
animal ankle annual answer anteater antelope antenna anthem antique anvil anyone apart apex appear
applaud apple approve apricot apron aqua arbor arcade arch archery archive arctic ardent area arena
argue arise ark armadillo armchair aroma around arrange arrive arrow art artichoke artist ascend
ash aside ask aspect aspen assemble asset assist assume asteroid athlete atlas atoll atom attach
attend attic attract auction audio aura author auto autumn avalanche avenue average aviary avocado
avoid awake awaken award aware away awesome awning axe axis azure baboon bachelor back backpack
bacon badge badger badminton bag bagel bagpipe baguette bake baker bakery balance balcony bale ball
ballad ballet balloon ballot bamboo banana band bandage banjo bank banner banquet bar barber barely
bargain barley barn barnacle barrel barrow base basic basil basin basket bat batch bathtub baton
battery bay bayou bazaar beach beacon beagle beaker beam bean bear beauty beaver beckon become bed
bee beef beet beetle before begin behave behind beige believe bell below belt bench bend benefit
beret berry best beta better between beyond bicycle bid bike binary bind bingo biology birch bird
birth biscuit bison bistro bit black blade blanket blazer blend blender bless blimp blink block
bloom blossom blouse blue blueberry bluebird bluegrass bluff blunt blur blush boar board boast boat
bobbin bobcat bodega body boil bold bolt bone bonfire bongo bonnet bonsai bonus book bookcase
bookmark boost boot border borrow boss bottle bottom boulder boulevard bounce bouquet bow bowl
bowling box bracelet brain bramble bran branch brand brass brave bravo bread breathe breeze breezy
brew brick bridge bridle brief bright bring brioche brisk brisket bristle broccoli broken bronze
brook broom brother brown brownie browse brush bubble bubbly bucket buckeye buckle bud buddy budget
buffalo buggy bugle build bulb bulldog bumblebee bundle bungalow bunny burger burgundy burlap
burrito burrow burst bus bushel business busy butte butter butterfly button buyer buzz buzzard byte
cabana cabbage cabin cabinet cable caboose cactus cadet cafe cairn cake calculate calico calm camel
cameo camera camp camper can canal canary candid candle candy canoe canopy canteen canvas canyon
capable cape capital captain car carafe caramel caravan carbon card cardigan career careful cargo
caribou carousel carp carpet carriage carrot carry cart carve cascade case cash cashew cashmere
castle casual cat catalog catch category catfish cathedral catnip cattle cauldron cause caution
cave cavern cedar ceiling celebrate celery cellar cello cement century cereal certain chair chalet
chalk chamber chameleon champion chance change chaos chapel chapter charcoal charge chariot charm
chase chat cheap check cheddar cheer cheerful cheese cheetah chef cherry chess chest chestnut
chicken chief chiffon chili chilly chimney chimp chipmunk chisel chive choice choir choose chord
chorus chowder chuckle chunk churn chutney cicada cider cinder cinnamon cipher circle circuit
citadel citizen city civic claim clam clamp clap clarify clarinet classic claw clay clean clerk
clever click client cliff climb clinic clip clipboard cloak clock close closet cloth cloud clove
clover club clue cluster coach coast coaster coat cobalt cobble cobbler cockatoo cocoa coconut cod
code coffee coin collar collect collie color column comb combine come comedy comet comfort comic
common company compass compose concert conch condor conduct confirm connect consider control cook
cookie cool copper copy coral cord corduroy core cork corn corral correct cosmic cosmos cost
cottage cotton couch cougar count country couple courage course court cove cover cow coyote cozy
crab crack cracker cradle craft cram cranberry crane crate crater crawl crayfish crayon cream
create creek crepe crescent crest crevice crew cricket crimson crisp critic crocus crop croquet
cross crouch crouton crow crowd crucial cruise crumb crumble crumpet crunch crystal cube cuckoo
cucumber cuddle cultivate culture cumin cup cupboard cupcake cupola curious current curry curtain
curve cushion custard custom cute cyan cycle cyclone cymbal cypress dabble dachshund dahlia dainty
dairy daisy dalmatian damask dance dandelion dapple daring darts dash data date dawn day dazzle
dazzling deal debate debut decade decibel decide decimal deck decline decor decorate decoy deer
define degree delay deliver delta demand denim dentist depart depend deposit depot depth deputy
derby derive desert design desk detail detect detour develop device devote dew dewdrop diagram dial
diamond diary dice diesel diet differ digital dignity dill dime dimple diner dinghy dingo dinner
dinosaur diode dipper direct discover dish display distance ditch dive divide dock doctor document
dodo dog doll dollop dolphin domain dome domino donate donkey donor donut doodle door doorbell
doormat dormer double dough dove draft dragonfly drama draw drawer dream dress drift driftwood
drill drink drip drive drizzle drop drum dry duck duet duffel dulcimer dumpling dune during dusk
dust dustpan duty dwell dynamic dynamo eager eagle early earmuff earn earnest earth easel east easy
ebony echo eclair eclipse ecology economy eddy edge edit editor educate eel effort egg eggplant
egret eiderdown eight either elbow elder electric electron elegant element elephant elevator elfin
elite elixir elk elm else embark embassy ember emblem embody embrace emerald emerge empire employ
empower emu enable enact encore end endless endorse energy engage engine enhance enjoy enlist
enough enrich enroll ensure enter entire entry envelope enzyme epic episode equal equator equip era
erase eraser erode errand erupt escape espresso essay essence estate estuary eternal ethics evening
event ever evergreen evidence evoke evolve exact exam examine example excess exchange excite
exclude excuse execute exercise exhibit exist exotic expand expect expert expire explain explore
expose express extend extra eye eyebrow fable fabric face factory faculty fade faint fairway fairy
faith falafel falcon fall fame family famous fan fancy fanfare fantasy farm farmhouse fashion
fatigue faucet favorite fawn fearless feast feather feature fee feed feel feline felt fence fennel
fern ferret ferris ferry festival festive feta fetch few fiber fiction fiddle field fierce fiesta
fig figure filbert file film filter final finch find fine finger finish fir fire firefly firewood
firm first fiscal fish fit fitness fix fjord flag flagpole flame flamingo flannel flapjack flash
flask flat flavor fleece flicker flight flint flip float flock flood floor flotilla flounder flour
flourish flow flower fluffy fluid flume flurry flush flute fluted fly foam focus fog fogbank foil
fold foliage folio follow fond fondue food foot footpath forage force forest forge forget forgive
fork formal formula fort fortune forum forward fossil foster found fountain fox foxglove fraction
fragile frame freckle frequent fresco fresh friend friendly frigate fringe frog frond front frost
frosty frozen fruit fuchsia fudge fuel fun funnel funny furnace fusion future fuzzy gable gadget
gain galaxy gallant galleon gallery gallon gallop game gamma gamut gap garage garden gardenia
garland garlic garnet gas gasp gate gather gauge gaze gazebo gazelle gazette gear gecko gelatin
gelato general genius genome genre gentle genuine gerbil gesture geyser giant gibbon gift gifted
giggle ginger gingham giraffe give glacier glad glade glance glass glaze gleaming glen glide glider
glimmer glimpse global globe glory glove glow glyph gnu goal goat gobbler goblet gold golden
goldenrod goldfish golf gondola good goose gopher gorge gorilla gossamer gourd gown grace graceful
grackle grain granary grand granite granola grant grape graph grasp grass grateful gravel gravity
gravy great green greet grid griffin grin grit grizzly grocery grotto group grouse grove grow guard
guava guess guest guide guild guitar gulf gull gumbo gumdrop guppy gust habit haiku hail hair half
halo halyard ham hamlet hammer hammock hamster hand hangar hanger happy harbor hard hardy hare
harmony harp harvest hat hatbox hatch hatchet have hawk hawthorn haze hazel hazelnut head headland
health heart hearth hearty heath heather heavy hedgehog hedgerow height helium helix hello helmet
help helpful hemlock hemp hen heraldry herb hero heroic heron herring hidden high hike hill hilltop
hilt hinge hint hip hippo hire history hobby hockey hold holiday hollow holly home homestead honest
honey honeybee honor hood hook hoop hope hopscotch horizon horn hornet horse horseshoe hose
hospital host hostel hotel hound hour hourglass hover hub huge hum human humble hummus humor
hundred hungry hurdle hurry husky hut hyacinth hybrid hydrant hydrogen hyena ibex ibis ice iceberg
icicle icon icy idea ideal identify idle igloo ignite ignore iguana image imagine immense immune
impact impala impose improve impulse inch include income increase index indicate indigo indoor
industry inform inhale inherit initial inject inkblot inkling inkwell inlet inn inner innocent
input inquiry insect inside inspire install intact interest into invent invest invite involve iris
iron island isle isolate issue isthmus item ivory ivy jackal jacket jade jaguar jam jamboree jar
jasmine jasper jaunt jay jazz jeans jeep jelly jellyfish jersey jester jetstream jetty jewel jigsaw
jingle job jockey jodhpur jog join joke jolly jonquil jot journal journey jovial joy joyful jubilee
judge jug juggle juice jukebox jumbo jump jungle junior juniper jury just kale kangaroo karate
kayak kebab keen keep keepsake kelp kennel kernel kestrel ketchup kettle key keyboard keychain
keystone khaki kick kiln kilt kind kindle kingdom kinship kiosk kipper kitchen kite kitten kiwi
knack knapsack kneel knight knit knob knock knoll knot know koala krill lab label labor lace
lacquer ladder ladle ladybug lagoon lake lamb lamp language lantern lanyard lapel laptop larch
large lark larkspur lasagna laser lasso latch later latin lattice laugh launch laundry laurel lava
lavender lavish law lawn layer leader leaf leaflet learn leather lecture ledge ledger leek left leg
legacy legal legend leisure lemming lemon lemonade lemur lend length lens lentil leopard lesson
lettuce library lichen lid life lift light lightning like lilac lily limb lime limerick limit
limpet linchpin linen linger link lintel lion liquid liquorice list listen little live lively
lizard llama load loan lobster local lock locker locket locust lodestar lodge loft lofty logic long
longbow loom loop lore lotus loud lounge love loyal luck lucky luggage lullaby lumber lunar lunch
lute luxury lynx lyric lyrics macaroni macaw machine mackerel magenta magic magnet magnolia magpie
mahogany mail main mainsail majestic major make mallard mallet mammal mammoth manage manatee
mandarin mandate mandolin mango mangrove manor mansion mantis mantle manual map maple marathon
marble march margin marigold marina marine marker market marmalade marmoset marmot maroon marsh
marten marvel marzipan mascot mask masonry mass master mat match material math matrix mattress
mauve maximum maze meadow mean meander measure meat mechanic medal medallion media medley meerkat
megabyte mellow melody melon melt member memory mend mention mentor menu mercy merge meringue merit
merlin merry mesa mesh message metal meteor method micro middle midnight midsummer mighty mild
milestone milk mill million millpond mimic mimosa mind mingle minimum minivan mink minnow minor
minstrel mint minuet minute miracle mirror mission mist mistral misty mitten mix mixture moat
mobile mocha model modem modern modest modify module molar mole molecule moment mongoose monitor
monkey monsoon month monument moon moonbeam moonlit mooring moose mop moped moral more morning
mosaic moss moth motion motor motto mountain mouse move movie much mud muffin mug mulberry mule
multiply mural muscle museum mushroom music muskrat muslin must mustang mustard mutual myrtle
mystery myth nacho nail name nanny napkin narrow narwhal nature nautilus navy near nebula neck need
needle negative neighbor neither neon nerve nest net nettle network neutral neutron never news newt
next nibble nice nickel night nightfall nightjar nimble ninja nitrogen noble nocturne nod noise
nomad nominee noodle nook noon normal north nose notable notch note notebook nothing notice nougat
novel nucleus nudge nugget number nurse nurture nut nutmeg nutshell nylon oak oarsman oasis oat
oath oatmeal obelisk obey object oblige oboe observe obtain obvious occur ocean ocelot ochre octave
octopus odor off offer office often oil oilcloth okay okra old olive omelet omen once one onion
online only onyx opal open opera opinion opossum oppose optic option opulent oracle orange orbit
orca orchard orchestra orchid ordinary oregano organ organize orient origami original oriole osprey
ostrich other otter ounce outdoor outer outfit outpost output outside oval oven over overture owl
own owner oxygen oyster ozone pact paddle paddock page pagoda pail paint pair paisley palace
palette palisade palm pan pancake panda panel panorama panther pantry papaya paper paprika papyrus
parade parakeet parapet parasol parcel parchment parent park parka parrot parsley particle
partridge party pass passport pasta pastel pastille pastry pasture patch patchwork path pathway
patient pattern pause pave pavilion payment peace peaceful peach peacock peak peanut pear pearl
pebble pecan peek pelican pen pencil penguin peninsula pennant peony people pepper perch perfect
perform permit person pesto pet petal pewter pheasant phone photo phrase physical piano piccolo
pickle picnic picture pie piece pier pigeon pike pillow pilot pin pinafore pine pineapple pinecone
pink pinwheel pioneer pipe piper piranha pistachio pita pitch pitcher pixel pizza place plaid plain
planet plank plasma plastic plate plateau platypus play playful plaza please pledge pliers plover
pluck plucky plug plum plume plunge pocket pocketful poem poet point polar polaris pole polite
polka pollen pomelo poncho pond ponder pony poodle pool popcorn poppy popular porch porcupine
porridge portico portion position possible possum post postcard pot potato potpourri pottery pounce
powder power practice prairie praise prance prawn predict prefer prepare present pretty pretzel
prevent price pride primary primrose print priority prism private prize problem process produce
profit program project promenade promise promote proof property prosper protect proud provide prowl
prune public pudding puddle puffin pull pulley pulp pulsar pulse puma pumice pumpkin pupil puppet
puppy purchase purity purple purpose purr purse push put puzzle pyramid quack quahog quail quaint
quake quality quantum quarry quarter quartet quartz quasar quatrain quay queen quench quest
question queue quiche quick quicksand quiet quill quilt quince quirk quit quiver quiz quota quote
rabbit raccoon race rack racket radar radiant radiate radio radish radius raft rafter ragtime rail
rain rainbow raise raisin rake rally ram ramble ramen ramp rampart ranch random range rapid rapids
rare raspberry rate rather rattle raven ravioli raw reach read ready real realm reason rebuild
recall receive recipe recital record recycle reduce redwood reed reef referee reflect reform regal
regalia regatta region regular reindeer rejoice relax relay release relief relish rely remain
remedy remember remind remove render renew rent reopen repair repeat replace report require rescue
resemble resist resource response rest result retire retreat return reunion reveal review revive
reward rhapsody rhino rhubarb rhythm rib ribbon rice rich riddle ride ridge right rind ring ripple
risk risotto ritual rival river riverbank road roadster roam roar roast robin robot robust rock
rocket rodeo rookie room rooster root rope rose rosebud rosette rosy rotate rotunda rough round
route row rowboat rowing royal rubber ruby rudder ruffle rug rugby rugged rule ruler rumble run
runestone runway rural rust rustic sack saddle saddlebag safe saffron saga sage sagebrush sail
sailboat sailing salad salami salmon salon salsa salt salute same sample sand sandbar sandstone
sandwich sapling sapphire sardine satchel satellite satin satisfy sauce saucer sausage savanna save
savor sawmill scale scallion scallop scamper scan scarecrow scarf scarlet scatter scene scheme
school schooner science scissors scone scoop scooter scout scrap screen screw script scroll scrub
sculpture sea seahorse seal search seashell season seat seaweed second secret section sedan seed
segment select sell seminar senior sense sensor sentinel sentry sepia sequoia serenade serene
series service sesame session settle setup seven sew sextant shadow shaft shallow shamrock shape
share shark shawl sheaf shed sheep shelf shell shelter sherbet shield shift shimmer shine shiny
ship shipyard shiver shoe shop shore shoreline short shortcake shoulder shovel shrew shrimp shrub
shrug shuffle shuttle shy sieve sight sign signal signet silent silicon silk silver similar simple
since sincere sing sip sitar situate six size skate skating sketch ski skiing skill skillet skin
skip skirt skunk sky skylark skyline slab slalom sled sleek sleep sleet sleigh slender slice slide
slight slim slipknot slipper slogan slope slot sloth slow slush small smart smile smooth snack
snail snap snappy sneaker sniff snow snowdrop snowfall snug soap soar soccer social sock soda sofa
soft solar solid solstice solve sonata song sonnet soon sorbet sorrel sort sound soup source south
soy space spare sparkle sparkly sparrow spatial spatula speak spectrum speed speedy spell spend
sphere spice spider spike spin spinach spinnaker spirit splash split sponge sponsor spool spoon
sport spot spray spread sprig spring sprint sprout spruce spry spyglass square squash squeeze squid
squirrel stable stack stadium staff stage stairs stallion stamp stand stanza stapler star stardust
starfish starlight start state station stay steady steak steel steeple stem step steppe stereo stew
stick still sting stingray stir stock stockade stomach stone stool stork storm story storybook
stove strategy stream street stretch string stroll strong strudel student studio study stuff
stumble sturdy style subject submit subway success such sudden suede sugar suggest suit suitcase
summer summit sun sunbeam sundae sundew sundial sunflower sunny sunrise sunset super supply supreme
sure surf surface surfing surge surprise surround survey sushi sustain swallow swamp swan swap
swarm sweater sweet sweetpea swift swim swing switch sycamore symbol symphony syrup system table
tablet tabletop tackle taco tadpole tahini tail talent talk talon tamale tamarind tan tangerine
tango tank tape tapestry tapioca tapir tarantula target tart tartan task taste taxi tea teach
teacup teakettle teal team teapot teardrop telescope tell tempest temple tempo ten tenant tender
tennis tent term termite tern terrace terrapin terrier test text thank thatch theater theme then
theory there thicket thimble thing thistle thorn thought thread three thrifty thrive throw thumb
thunder thyme tiara ticket tide tidy tie tiger tilt timber time timely tinderbox tinker tinsel tiny
tip tissue title toad toadstool toast toaster today toe toffee tofu together token tollgate tomato
tomorrow tone tongue tonight tool toolbox tooth top topaz topiary topic topple torch tornado
tortilla tortoise toss total totem toucan tourist toward towel tower town towpath toy trace track
tractor trade traffic trailer train tram tranquil trap trapeze travel tray treasure treat tree
treetop trellis trend trial tribute trick trim trinket trip trophy trout trowel truck true truffle
truly trumpet trunk trust trusty truth try tuba tube tugboat tuition tulip tumble tuna tundra tunic
tunnel turkey turn turnip turquoise turret turtle tutor tuxedo tweed tweezers twelve twenty twice
twig twilight twin twine twirl twist type typhoon typical ukulele ultra umber umbrella umpire
uncover under undertow undo unfold unicorn uniform union unique unison unit unite unity universe
unknown unlock until unusual unveil unwind upbeat update upgrade uphold upland uplift upon upper
upright upstairs upward urban urchin usage use useful usual utility utmost vacant vacuum vagabond
valance valiant valid valley value valve van vanilla vanish vapor various vase vast vault vector
vehicle veil vellum velocity velvet vendor venture venue verandah verb verify verse version very
vessel vest vestibule veteran viable viaduct vibrant victory video view vignette viking villa
village vine vinegar vineyard vintage vinyl viola violet violin virtual virtuoso visa vision visit
visor vista visual vital vivid vocal voice volcano vole voltage volume vortex vote voyage waffle
wage wagon waistcoat wait walk wall wallet walnut walrus waltz wand wander wanderer want warble
warbler wardrobe warehouse warm wasabi wash washer wasp waste water waterfall waterfowl wave way
wayfarer wealth wear weasel weather weave web wedding weekend welcome west wet wetland whale wharf
what wheat wheel when where whippet whirlwind whisk whisker whisper whistle wick wicker wide widget
width wiggle wild will willow win wind windchime windmill window wing wingspan wink winner winter
wire wisdom wise wish wishbone wisteria witness witty wizard wolf wombat wonder wood woodland
woodpile woodwind wool word work world worm worth wrap wreath wren wrench wrist write xylophone
yacht yak yam yard yardarm yarn yarrow yawn year yearling yearn yeast yellow yeti yew yodel yoga
yogurt yolk yonder young youth yucca yuletide zany zeal zebra zenith zephyr zeppelin zero zest
zesty zigzag zinc zipper zither zodiac zone zoo zoom zucchini
`;

/** @type {readonly string[]} */
export const WORDS = Object.freeze(RAW.trim().split(/\s+/));
